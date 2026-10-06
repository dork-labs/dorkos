import { z } from 'zod';
import { ProcessIdentitySchema } from '../lifecycle/process-journal.js';
import { parseDarwinChildrenBatch, type DarwinChildrenBatch } from './darwin-process-observer.js';

/** Private observed kernel facts only; this record grants no cleanup or browser authority. */
export interface DarwinJournalDiagnostic {
  readonly kind: 'incomplete-native-children';
  readonly journalId: string;
  readonly parent: Readonly<z.infer<typeof ProcessIdentitySchema>>;
  readonly batch: Readonly<DarwinChildrenBatch>;
}
const header = z
  .object({
    kind: z.literal('incomplete-native-children'),
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
      parent: Object.freeze(parsed.parent),
      batch: Object.freeze(batch),
    });
  }
  return value;
}
