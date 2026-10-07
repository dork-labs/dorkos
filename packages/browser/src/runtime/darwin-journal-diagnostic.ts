import { z } from 'zod';
import { ProcessIdentitySchema } from '../lifecycle/process-journal.js';
import { parseDarwinChildrenBatch, type DarwinChildrenBatch } from './darwin-process-observer.js';

export type OriginalChildBatchReason =
  'CHILDREN_INCOMPLETE' | 'CHILD_BOOT_MISMATCH' | 'CHILD_UNQUALIFIED';

/** Private observed kernel facts only; this record grants no cleanup or browser authority. */
export interface DarwinJournalDiagnostic {
  readonly kind: 'incomplete-native-children';
  readonly journalId: string;
  readonly sequence?: number;
  readonly reason?: OriginalChildBatchReason;
  readonly parent: Readonly<z.infer<typeof ProcessIdentitySchema>>;
  readonly batch: Readonly<DarwinChildrenBatch>;
}
const header = z
  .object({
    kind: z.literal('incomplete-native-children'),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    reason: z.enum(['CHILDREN_INCOMPLETE', 'CHILD_BOOT_MISMATCH', 'CHILD_UNQUALIFIED']).optional(),
    parent: ProcessIdentitySchema,
    batch: z.unknown(),
  })
  .strict();

/** Read only the original worker's single typed line, never arbitrary stderr into a receipt. */
export function readDarwinJournalDiagnostic(
  bytes: Uint8Array,
  journalId: string
): DarwinJournalDiagnostic | undefined {
  if (bytes.byteLength > 262144) throw new Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
  let value: DarwinJournalDiagnostic | undefined;
  for (const line of lines) {
    if (!line.startsWith('{"kind":"incomplete-native-children",')) continue;
    if (value) throw new Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
    const parsed = header.parse(JSON.parse(line));
    const batch = parseDarwinChildrenBatch(
      new TextEncoder().encode(JSON.stringify(parsed.batch)),
      parsed.parent
    );
    for (const fact of batch.processes) {
      if (fact.kind === 'present') Object.freeze(fact.identity);
      Object.freeze(fact);
    }
    if (batch.parentBefore) Object.freeze(batch.parentBefore);
    if (batch.parentAfter) Object.freeze(batch.parentAfter);
    Object.freeze(batch.processes);
    value = Object.freeze({
      kind: 'incomplete-native-children',
      journalId,
      ...(parsed.sequence === undefined ? {} : { sequence: parsed.sequence }),
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      parent: Object.freeze(parsed.parent),
      batch: Object.freeze(batch),
    });
  }
  return value;
}

/** Capture one original stderr writer before cleanup; this sink grants no authority. */
export function createOriginalChildBatchDiagnosticSink(
  supplied?: (bytes: string, done: (error?: unknown) => void) => unknown
) {
  let write: typeof supplied;
  let captureFailure: { value: unknown } | undefined;
  try {
    if (supplied) write = supplied;
    else {
      const captured = process.stderr.write.bind(process.stderr);
      write = (bytes, done) => captured(bytes, (error) => done(error));
    }
  } catch (value) {
    captureFailure = { value };
  }
  let emitted: Promise<void> | undefined;
  return (diagnostic: DarwinJournalDiagnostic): Promise<void> => {
    if (emitted) return emitted;
    emitted = Promise.resolve().then(() => {
      if (captureFailure) throw captureFailure.value;
      // The original parser admits only exact native facts; never serialize arbitrary participant properties.
      const checked = readDarwinJournalDiagnostic(
        new TextEncoder().encode(
          JSON.stringify({
            kind: diagnostic.kind,
            ...(diagnostic.sequence === undefined ? {} : { sequence: diagnostic.sequence }),
            ...(diagnostic.reason === undefined ? {} : { reason: diagnostic.reason }),
            parent: diagnostic.parent,
            batch: diagnostic.batch,
          }) + '\n'
        ),
        diagnostic.journalId
      );
      if (!checked) throw Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
      const bytes = 'JOURNAL_ORIGINAL_CHILDREN: ' + JSON.stringify(checked) + '\n';
      if (Buffer.byteLength(bytes) > 262144) throw Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
      return new Promise<void>((resolve, reject) => {
        try {
          write!(bytes, (error) => {
            if (error !== undefined && error !== null) reject(error);
            else resolve();
          });
        } catch (value) {
          reject(value);
        }
      });
    });
    void emitted.catch(() => {});
    return emitted;
  };
}
