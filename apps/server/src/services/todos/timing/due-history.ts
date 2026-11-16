import type { TodoRow } from '@dorkos/db';

/** The due-date fields whose history changes together. */
export type DueHistory = Pick<TodoRow, 'dueAt' | 'originalDueAt' | 'scoreDueAt' | 'moveCount'>;

/** The date on-time is judged against right now: the score date, or the due date on a legacy row. */
function judgedDate(current: DueHistory): string | null {
  return current.scoreDueAt ?? current.dueAt;
}

/**
 * Whether a change made at `now` comes at or after the date the to-do is judged against, so the
 * miss stands (DOR-3034). Judged against the score date, not the current one: after one late move,
 * every later move is late too.
 *
 * @param current - The currently stored due date and its history.
 * @param now - The time of the change, in epoch milliseconds.
 */
export function isLateMove(current: DueHistory, now: number): boolean {
  const judged = judgedDate(current);
  return judged !== null && now >= Date.parse(judged);
}

/**
 * Apply one due-date change without rewriting the promise's history (DOR-3034).
 *
 * The first date a to-do ever has is its permanent original date. The score date is the one
 * on-time is judged against. A change made before that date is a renegotiation, so the score
 * follows it, and clearing the date then lets go of the score too. A change made at or after it
 * keeps the date already missed, so no later move or clear and re-set can turn a late to-do into
 * an on-time one. Changing an existing date counts as a move, clearing included; giving an undated
 * to-do a date does not.
 *
 * @param current - The currently stored due date and its history.
 * @param nextDue - The normalized next due date, or null to clear it.
 * @param now - The time of the change, in epoch milliseconds.
 * @returns All four due-date fields to store together.
 */
export function nextDueHistory(
  current: DueHistory,
  nextDue: string | null,
  now: number
): DueHistory {
  if (nextDue === current.dueAt) return { ...current };
  return {
    dueAt: nextDue,
    originalDueAt: current.originalDueAt ?? current.dueAt ?? nextDue,
    scoreDueAt: isLateMove(current, now) ? judgedDate(current) : nextDue,
    moveCount: current.moveCount + (current.dueAt !== null ? 1 : 0),
  };
}
