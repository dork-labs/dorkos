import { z } from 'zod';

const error = z.number().int().min(0).max(2147483647);
const header = z
  .object({
    kind: z.literal('original-native-unknown'),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    fact: z
      .object({
        kind: z.literal('unknown'),
        pid: z.number().int().positive().max(2147483647),
        error: z.number().int(),
        uncertainty: z
          .enum([
            'birth-changed',
            'parent-changed',
            'alive-to-zombie',
            'zombie-to-alive',
            'membership-disappeared',
            'membership-appeared',
            'membership-absent-with-present-reads',
          ])
          .optional(),
        inspection: z
          .object({
            membershipBefore: z.boolean(),
            membershipAfter: z.boolean(),
            firstError: error,
            secondError: error,
            firstZombie: z.boolean().nullable(),
            secondZombie: z.boolean().nullable(),
            birthChanged: z.boolean().nullable(),
            parentChanged: z.boolean().nullable(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    leaf: z
      .object({
        watched: z.boolean(),
        enrolled: z.boolean(),
        forked: z.boolean(),
        exited: z.boolean(),
        consumed: z.boolean(),
        receiverFailed: z.boolean(),
        receiverClosed: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** Parse only the already-returned original worker's bounded unknown fact; grants no authority. */
export function readOriginalUnknownJournalDiagnostic(bytes: Uint8Array, journalId: string) {
  if (bytes.byteLength > 262144) throw new Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
  let value: Readonly<z.infer<typeof header> & { journalId: string }> | undefined;
  let firstKind: 'unknown' | 'children' | undefined;
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n')) {
    if (line.startsWith('{"kind":"incomplete-native-children",')) firstKind ??= 'children';
    if (!line.startsWith('{"kind":"original-native-unknown",')) continue;
    firstKind ??= 'unknown';
    if (value || Buffer.byteLength(line) > 2048) throw new Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
    const parsed = header.parse(JSON.parse(line));
    if (parsed.fact.inspection) Object.freeze(parsed.fact.inspection);
    Object.freeze(parsed.fact);
    if (parsed.leaf) Object.freeze(parsed.leaf);
    value = Object.freeze({ ...parsed, journalId });
  }
  return firstKind === 'unknown' ? value : undefined;
}

/** Capture and join one original stderr callback; output cannot heal an unknown journal. */
export function createOriginalUnknownJournalDiagnosticSink(
  supplied?: (bytes: string, done: (error?: unknown) => void) => unknown
) {
  let write: typeof supplied;
  let first: { value: unknown } | undefined;
  try {
    if (supplied) write = supplied;
    else {
      const captured = process.stderr.write.bind(process.stderr);
      write = (bytes, done) => captured(bytes, (error) => done(error));
    }
  } catch (value) {
    first = { value };
  }
  let emitted: Promise<void> | undefined;
  return (
    original: NonNullable<ReturnType<typeof readOriginalUnknownJournalDiagnostic>>
  ): Promise<void> => {
    if (emitted) return emitted;
    emitted = Promise.resolve().then(() => {
      if (first) throw first.value;
      const fact = original.fact;
      const inspection = fact.inspection;
      const leaf = original.leaf;
      // Project only fixed native scalars; participant extras/toJSON are never serialized.
      const raw = {
        kind: original.kind,
        sequence: original.sequence,
        fact: {
          kind: fact.kind,
          pid: fact.pid,
          error: fact.error,
          ...(fact.uncertainty === undefined ? {} : { uncertainty: fact.uncertainty }),
          ...(inspection === undefined
            ? {}
            : {
                inspection: {
                  membershipBefore: inspection.membershipBefore,
                  membershipAfter: inspection.membershipAfter,
                  firstError: inspection.firstError,
                  secondError: inspection.secondError,
                  firstZombie: inspection.firstZombie,
                  secondZombie: inspection.secondZombie,
                  birthChanged: inspection.birthChanged,
                  parentChanged: inspection.parentChanged,
                },
              }),
        },
        leaf:
          leaf === null
            ? null
            : {
                watched: leaf.watched,
                enrolled: leaf.enrolled,
                forked: leaf.forked,
                exited: leaf.exited,
                consumed: leaf.consumed,
                receiverFailed: leaf.receiverFailed,
                receiverClosed: leaf.receiverClosed,
              },
      };
      const checked = readOriginalUnknownJournalDiagnostic(
        new TextEncoder().encode(JSON.stringify(raw) + '\n'),
        original.journalId
      );
      if (!checked) throw new Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
      const bytes = 'JOURNAL_ORIGINAL_UNKNOWN: ' + JSON.stringify(checked) + '\n';
      if (Buffer.byteLength(bytes) > 4096) throw new Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
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
