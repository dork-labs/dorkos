import type { TodoRow } from '@dorkos/db';

/** The due-date fields whose history changes together. */
export type DueHistory = Pick<TodoRow, 'dueAt' | 'originalDueAt' | 'scoreDueAt' | 'moveCount'>;

/**
 * Apply one due-date change without rewriting the promise's history (DOR-3034).
 *
 * The first date becomes both the permanent original date and the date used to score whether the
 * to-do was kept on time. Moving an existing date before it is due is a renegotiation, so scoring
 * follows the new date. Moving it at or after the due moment is a late move, so scoring stays on
 * the date already missed. Clearing a date preserves both history dates. A change away from any
 * existing non-null date increments the move count, including clearing it.
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
  if (current.dueAt === null) {
    const firstDate = current.originalDueAt === null && nextDue !== null;
    // A date set again after it was cleared is judged against the scored date, not the cleared
    // one: before that date it is a renegotiation, after it the to-do stays late. Clearing a late
    // date and setting a new one must never wipe the miss.
    const renegotiated =
      !firstDate &&
      nextDue !== null &&
      current.scoreDueAt !== null &&
      now < Date.parse(current.scoreDueAt);
    return {
      dueAt: nextDue,
      originalDueAt: firstDate ? nextDue : current.originalDueAt,
      scoreDueAt: firstDate || renegotiated ? nextDue : current.scoreDueAt,
      moveCount: current.moveCount,
    };
  }
  const renegotiated = nextDue !== null && now < Date.parse(current.dueAt);
  return {
    dueAt: nextDue,
    originalDueAt: current.originalDueAt,
    scoreDueAt: renegotiated ? nextDue : current.scoreDueAt,
    moveCount: current.moveCount + 1,
  };
}
