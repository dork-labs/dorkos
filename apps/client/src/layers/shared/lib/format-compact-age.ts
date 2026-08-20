/**
 * How long ago, in the fewest characters that still say it.
 *
 * **The second of the two time formats, and the difference is deliberate.**
 * `formatRelativeTime` in `session-utils.ts` writes the sentence form —
 * "Just now", "45m ago", "3 days ago" — for places with a line to spend. This
 * one writes "5m", "2h", "3d" for the right-hand column of a dense row, where
 * the timestamp shares its line with a title, a body and sometimes a button.
 *
 * It lives in `shared` because two slices now draw those rows: attention signals
 * (`features/dashboard-attention`) and Inbox notifications (`features/inbox`),
 * which sit one line apart in home's header and in the Pulse panel. Two
 * spellings of the same fact that close together read as two different facts.
 *
 * @module shared/lib/format-compact-age
 */

/** Milliseconds in a minute. */
const MINUTE_MS = 60_000;

/** Minutes in an hour. */
const MINUTES_PER_HOUR = 60;

/** Hours in a day. */
const HOURS_PER_DAY = 24;

/**
 * Format an ISO timestamp as a compact age.
 *
 * Floors rather than rounds, so nothing is ever reported as older than it is.
 * A future timestamp — clock skew between a server and a browser — reads `0m`
 * rather than a negative number.
 *
 * @param iso - ISO 8601 timestamp.
 * @returns An age like `5m`, `2h`, or `3d`.
 */
export function formatCompactAge(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(diff / MINUTE_MS);
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours}h`;
  return `${Math.floor(hours / HOURS_PER_DAY)}d`;
}
