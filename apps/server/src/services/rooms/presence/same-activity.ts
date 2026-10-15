/**
 * Whether two readings of a turn's live activity say the same thing. Split out
 * of `room-trigger.ts` so that file stays inside its line budget.
 *
 * @module server/services/rooms/presence/same-activity
 */
import type { SessionActivity } from '@dorkos/shared/session-stream';

/**
 * Whether two readings say the same thing about a turn.
 *
 * The same tool on the same target is not a change, so it is neither worth a
 * frame nor worth restarting anything on screen for.
 *
 * @param a - One reading, or `undefined` for none.
 * @param b - The other.
 */
export function sameActivity(
  a: SessionActivity | undefined,
  b: SessionActivity | undefined
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.toolName === b.toolName && a.target === b.target;
}
