/**
 * Relative-time formatting for the instance registry (accounts-and-auth P2).
 *
 * @module features/instances/lib/relative-time
 */
import { formatDistanceToNow } from 'date-fns';

/**
 * Format an ISO timestamp as a human relative time (e.g. "3 minutes ago"),
 * falling back to a neutral label for an unparseable value.
 *
 * @param iso - An ISO-8601 timestamp string.
 */
export function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return formatDistanceToNow(date, { addSuffix: true });
}
