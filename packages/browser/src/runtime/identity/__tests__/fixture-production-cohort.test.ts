import type { ProcessIdentity } from '../../../configuration.js';
import { it, expect, vi, onTestFinished } from 'vitest';
import {
  candidateOriginals,
  independentlyObserveCandidateReturns,
} from './fixture-production-cohort.js';
const root = { pid: 500001, birth: 'original-candidate-root' };
const child = { pid: 500002, birth: 'original-candidate-helper' };

it('refuses omitted root, repeated exact birth and an oversized candidate receipt', () => {
  expect(() => candidateOriginals(root, [child])).toThrow('CHROME_MATRIX_CANDIDATE_ROOT_MISSING');
  expect(() => candidateOriginals(root, [root, root])).toThrow();
  expect(() =>
    candidateOriginals(
      root,
      Array.from({ length: 513 }, (_, index) => ({
        pid: 500001 + index,
        birth: 'original-' + index,
      }))
    )
  ).toThrow();
});

/** Semantic observer control only; this never establishes native process return. */
it('joins every original candidate observation before refusing an unknown descendant', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let returned = false;
  const observe = vi.fn(async (identity: ProcessIdentity) => {
    if (identity.pid === child.pid) {
      await held;
      returned = true;
      return { status: 'dead' as const };
    }
    return { status: 'unknown' as const };
  });
  const whole = independentlyObserveCandidateReturns(root, [root, child], observe, (producer) =>
    Promise.resolve().then(producer)
  );
  void whole.catch(() => {});
  onTestFinished(async () => {
    release();
    await Promise.allSettled([whole]);
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(observe).toHaveBeenCalledTimes(2);
  expect(returned).toBe(false);
  release();
  await expect(whole).rejects.toThrow('CHROME_MATRIX_CANDIDATE_RETURN_UNVERIFIED');
  expect(returned).toBe(true);
});

it('preserves original undefined rejection and still observes its sibling birth', async () => {
  const observe = vi.fn(async (identity: ProcessIdentity) => {
    if (identity.pid === root.pid) throw undefined;
    return { status: 'dead' as const };
  });
  const whole = independentlyObserveCandidateReturns(root, [root, child], observe, (producer) =>
    Promise.resolve().then(producer)
  );
  await expect(whole).rejects.toBeUndefined();
  expect(observe).toHaveBeenCalledTimes(2);
});
