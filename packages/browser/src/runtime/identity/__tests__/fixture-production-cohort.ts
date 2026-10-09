import { z } from 'zod';
import type { ProcessIdentity, ProcessObservation } from '../../../configuration.js';

export const OriginalProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    birth: z.string().min(1).max(128),
  })
  .strict();
export const CandidateOriginalsSchema = z
  .array(OriginalProcessIdentitySchema)
  .min(1)
  .max(512)
  .superRefine((values, ctx) => {
    const names = new Set<string>();
    for (const value of values) {
      const key = value.pid + ':' + value.birth;
      if (names.has(key))
        ctx.addIssue({ code: 'custom', message: 'Original candidate birth repeated' });
      names.add(key);
    }
  });

/** Original identities, not a child-reported cleanup verdict. Empty, duplicate, oversized,
 * root-missing and malformed cohorts cannot establish complete candidate capture. */
export function candidateOriginals(
  root: ProcessIdentity,
  input: unknown
): readonly ProcessIdentity[] {
  const expected = OriginalProcessIdentitySchema.parse(root);
  const values = CandidateOriginalsSchema.parse(input);
  if (
    values.filter((value) => value.pid === expected.pid && value.birth === expected.birth)
      .length !== 1
  )
    throw new Error('CHROME_MATRIX_CANDIDATE_ROOT_MISSING');
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}

/** Called only after the actual original worker terminal and both pipes return. Each retained
 * birth reaches the parent's captured original native observer; one failure cannot skip siblings.
 * Alive, unknown and rejected observation remain failure, including a falsy original rejection. */
export async function independentlyObserveCandidateReturns(
  root: ProcessIdentity,
  input: unknown,
  observe: (identity: ProcessIdentity) => Promise<ProcessObservation>,
  track: <T>(producer: () => Promise<T>) => Promise<T>
): Promise<void> {
  const rows = candidateOriginals(root, input);
  const outcomes = await Promise.allSettled(rows.map((identity) => track(() => observe(identity))));
  let first: Readonly<{ value: unknown }> | undefined;
  for (const outcome of outcomes)
    if (outcome.status === 'rejected') first ??= { value: outcome.reason };
    else if (outcome.value.status !== 'dead')
      first ??= { value: new Error('CHROME_MATRIX_CANDIDATE_RETURN_UNVERIFIED') };
  if (first) throw first.value;
}
