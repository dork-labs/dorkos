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
import { bucketElapsedMs } from './bucket-elapsed-ms';

/** The letter each unit is spelled with here. */
const SUFFIX = { minute: 'm', hour: 'h', day: 'd' } as const;

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
  const { value, unit } = bucketElapsedMs(Date.now() - new Date(iso).getTime());
  return `${value}${SUFFIX[unit]}`;
}
