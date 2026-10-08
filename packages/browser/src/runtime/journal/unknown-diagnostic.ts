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

const observerPhase = z.enum([
  'initial-commit',
  'owner-inspect',
  'enrolled',
  'root',
  'sweep-inspect',
  'root-association',
  'children',
  'leaf-enroll',
  'leaf-baseline',
  'snapshot-commit',
  'snapshot-validate',
  'enumeration-close',
  'checkpoint',
  'pause',
]);
const observerCode = z.enum([
  'PROCESS_OBSERVATION_UNAVAILABLE',
  'PROCESS_OBSERVER_CLOSED',
  'LEAF_EVENT_OWNER_UNAVAILABLE',
  'LEAF_EVENT_OWNER_CLOSED',
  'LEAF_EVENT_BASELINE_UNAVAILABLE',
  'LEAF_EVENT_OVERFLOW',
  'LEAF_EVENT_PIPE_UNCERTAIN',
  'LEAF_EVENT_CHILD_UNCERTAIN',
  'JOURNAL_UNCERTAIN',
  'JOURNAL_PRECLOSE_REFUSED',
  'OWNER_UNAVAILABLE',
  'ROOT_UNAVAILABLE',
]);
const observerFailure = z
  .object({
    kind: z.literal('original-observer-failure'),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    phase: observerPhase,
    failure: z.enum(['undefined', 'false', 'error', 'other']),
    code: observerCode.optional(),
  })
  .strict();
export type OriginalObserverPhase = z.infer<typeof observerPhase>;

/** Closed projection of the original catch value; never invokes participant getters or serializes an error. */
export function projectOriginalObserverFailure(
  sequence: number,
  phase: OriginalObserverPhase,
  value: unknown
) {
  let failure: z.infer<typeof observerFailure>['failure'] =
    value === undefined ? 'undefined' : value === false ? 'false' : 'other';
  let code: z.infer<typeof observerCode> | undefined;
  try {
    if (value instanceof Error) {
      failure = 'error';
      const message = Object.getOwnPropertyDescriptor(value, 'message');
      if (message && 'value' in message) {
        const parsed = observerCode.safeParse(message.value);
        if (parsed.success) code = parsed.data;
      }
    }
  } catch {
    /* Observation cannot replace the original catch value. */
  }
  return Object.freeze(
    observerFailure.parse({
      kind: 'original-observer-failure',
      sequence,
      phase,
      failure,
      ...(code === undefined ? {} : { code }),
    })
  );
}

/** Parse one original bounded failure line after the worker's original pipes return. */
export function readOriginalObserverFailure(bytes: Uint8Array) {
  if (bytes.byteLength > 262144) throw new Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
  let original: z.infer<typeof observerFailure> | undefined;
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n')) {
    if (!line.startsWith('{"kind":"original-observer-failure",')) continue;
    if (original || Buffer.byteLength(line) > 512)
      throw new Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
    original = Object.freeze(observerFailure.parse(JSON.parse(line)));
  }
  return original;
}

/** Retain one original stderr callback; a diagnostic never changes the original refusal. */
export function createOriginalObserverFailureSink(
  supplied?: (bytes: string, done: (error?: unknown) => void) => void | boolean,
  parent = false
) {
  let write: typeof supplied;
  let first: { value: unknown } | undefined;
  try {
    if (supplied) write = supplied;
    else {
      const original = process.stderr.write.bind(process.stderr);
      write = (bytes, done) => original(bytes, (error) => done(error));
    }
  } catch (value) {
    first = { value };
  }
  let returned: Promise<void> | undefined;
  return (row: NonNullable<ReturnType<typeof readOriginalObserverFailure>>): Promise<void> => {
    if (returned) return returned;
    returned = Promise.resolve().then(() => {
      if (first) throw first.value;
      const checked = observerFailure.parse({
        kind: row.kind,
        sequence: row.sequence,
        phase: row.phase,
        failure: row.failure,
        ...(row.code === undefined ? {} : { code: row.code }),
      });
      const bytes = (parent ? 'JOURNAL_ORIGINAL_FAILURE: ' : '') + JSON.stringify(checked) + '\n';
      if (Buffer.byteLength(bytes) > 1024) throw new Error('JOURNAL_DIAGNOSTIC_UNAVAILABLE');
      return new Promise<void>((resolve, reject) => {
        try {
          write!(bytes, (error) =>
            error !== undefined && error !== null ? reject(error) : resolve()
          );
        } catch (value) {
          reject(value);
        }
      });
    });
    void returned.catch(() => {});
    return returned;
  };
}
