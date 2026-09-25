import type { Session } from '@dorkos/shared/types';
import { bucketElapsedMs } from './bucket-elapsed-ms';
import { TIME_UNITS } from './constants';

export type TimeGroup = 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Previous 30 Days' | 'Older';

export interface GroupedSessions {
  label: TimeGroup;
  sessions: Session[];
}

const GROUP_ORDER: TimeGroup[] = [
  'Today',
  'Yesterday',
  'Previous 7 Days',
  'Previous 30 Days',
  'Older',
];

/**
 * Group sessions into temporal buckets based on updatedAt.
 * Sessions are already sorted newest-first from the API.
 * Returns only non-empty groups.
 */
export function groupSessionsByTime(sessions: Session[]): GroupedSessions[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const sevenDaysAgo = new Date(todayStart);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const thirtyDaysAgo = new Date(todayStart);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const groups: Record<TimeGroup, Session[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 Days': [],
    'Previous 30 Days': [],
    Older: [],
  };

  for (const session of sessions) {
    const date = new Date(session.updatedAt);
    if (date >= todayStart) groups['Today'].push(session);
    else if (date >= yesterdayStart) groups['Yesterday'].push(session);
    else if (date >= sevenDaysAgo) groups['Previous 7 Days'].push(session);
    else if (date >= thirtyDaysAgo) groups['Previous 30 Days'].push(session);
    else groups['Older'].push(session);
  }

  return GROUP_ORDER.map((label) => ({ label, sessions: groups[label] })).filter(
    (group) => group.sessions.length > 0
  );
}

/**
 * Shorten an absolute path by replacing the home directory prefix with ~.
 * Handles macOS (/Users/) and Linux (/home/).
 */
export function shortenHomePath(absolutePath: string): string {
  return absolutePath.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/**
 * How recent a timestamp must be to read as a count ("5m ago", "3h ago") even
 * when midnight falls in between.
 *
 * Why six hours: checking the calendar day first turned a timestamp five
 * minutes old into "Yesterday, 11 pm" for the first hour after every midnight,
 * which reads as stale when it is not. Within a few hours a count is what a
 * person wants to know. Once the day has turned and more time has passed, the
 * clock time ("Yesterday, 9 pm") is the more useful answer than "9h ago". Six
 * hours covers a working evening that runs past midnight. Times from earlier
 * today keep counting in hours however old they are, as they always have.
 */
const RELATIVE_WINDOW_HOURS = 6;

/**
 * Format an ISO timestamp as a short, human "when".
 *
 * Elapsed time wins over the calendar for recent timestamps, so a moment five
 * minutes before midnight still reads "5m ago" just after it:
 *
 * - Under a minute: "Just now"
 * - Under an hour: "5m ago"
 * - Under {@link RELATIVE_WINDOW_HOURS} hours, or any earlier time today: "3h ago"
 * - Yesterday (otherwise): "Yesterday, 11 pm"
 * - Within the last week: "Tue, 10 am"
 * - Older: "Jan 5, 10 am"
 *
 * A timestamp in the future (clock skew, or a scheduled time) reads "Just now",
 * because {@link bucketElapsedMs} clamps negative spans to zero.
 *
 * @param isoString - The timestamp to describe, as an ISO 8601 string.
 * @returns A short label relative to the current time, in the viewer's time zone.
 */
export function formatRelativeTime(isoString: string): string {
  const now = new Date();
  const date = new Date(isoString);
  const elapsedMs = now.getTime() - date.getTime();

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const sevenDaysAgo = new Date(todayStart);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const elapsed = bucketElapsedMs(elapsedMs);
  if (elapsed.unit === 'minute') {
    return elapsed.value < 1 ? 'Just now' : `${elapsed.value}m ago`;
  }
  // Hours are counted directly rather than read off the bucket: on the day
  // clocks fall back, "today" is 25 hours long, and its first hour is a whole
  // day old by the bucket's reckoning.
  const hours = Math.floor(elapsedMs / TIME_UNITS.MS_PER_HOUR);
  if (hours < RELATIVE_WINDOW_HOURS || date >= todayStart) return `${hours}h ago`;

  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).toLowerCase();

  if (date >= yesterdayStart) return `Yesterday, ${timeStr}`;

  if (date >= sevenDaysAgo) {
    const day = date.toLocaleDateString('en-US', { weekday: 'short' });
    return `${day}, ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dateStr}, ${timeStr}`;
}
