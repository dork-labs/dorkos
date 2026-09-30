import type { OwnerReplacementState } from './records.js';

/**
 * Every move an owner replacement can make, from the spec's state diagram. A closed state has
 * no way out: a closed replacement never reopens.
 */
const TRANSITIONS: Readonly<Record<OwnerReplacementState, readonly OwnerReplacementState[]>> = {
  notifying: ['waiting', 'objected', 'withdrawn', 'superseded'],
  waiting: ['claimable', 'objected', 'withdrawn', 'superseded'],
  claimable: ['completed', 'objected', 'withdrawn', 'superseded', 'expired'],
  completed: [],
  objected: [],
  withdrawn: [],
  superseded: [],
  expired: [],
};

/** Whether a replacement may move from `from` to `to`. */
export function canTransition(from: OwnerReplacementState, to: OwnerReplacementState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The open states a replacement may move to `to` from, for a guarded `UPDATE … WHERE`. */
export function statesBefore(to: OwnerReplacementState): OwnerReplacementState[] {
  return (Object.keys(TRANSITIONS) as OwnerReplacementState[]).filter((from) =>
    canTransition(from, to)
  );
}
