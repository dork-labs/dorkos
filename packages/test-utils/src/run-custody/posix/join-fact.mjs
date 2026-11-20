/** Classify a join frame after the POSIX guardian channel authenticated it. */
export function classifyPosixJoin(fact, sawNative) {
  if (fact?.kind === 'cleaned-owned') return { kind: 'cleaned-owned' };
  if (fact?.kind === 'never-acquired' && !sawNative)
    return { kind: 'cleaned-owned', target: 'never-authorized' };
  return {
    kind: 'cleanup-uncertain',
    reason:
      fact?.kind === 'never-acquired'
        ? 'guardian-no-target-contradicted'
        : 'guardian-reported-uncertain',
  };
}
