/**
 * Small pieces of notification copy the registry's titles and bodies share:
 * dates and limit names, in the words a person reads.
 *
 * @module services/notifications/notification-copy
 */
import { windowLabel } from '@dorkos/shared/account-usage';
import type { NotificationPayload } from './notification-registry.js';

/** A date as an owner-replacement notice says it, in UTC. */
const OWNER_REPLACEMENT_DATE = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * When an open owner replacement could happen, as the end of a sentence. In UTC, named, because
 * a notification is written once on the server and read wherever the person is.
 *
 * @param p - An open replacement's payload.
 */
export function ownerReplacementWhen(
  p: Extract<NotificationPayload<'community.owner-replacement'>, { phase: 'open' }>
): string {
  if (p.claimable) return 'at any time now';
  if (p.claimableAfter)
    return `on or after ${OWNER_REPLACEMENT_DATE.format(new Date(p.claimableAfter))} (UTC)`;
  return 'after a waiting period of at least 7 days';
}

/**
 * A reset time in the server's local zone, short, e.g. `9/27/26, 8:00 PM`.
 *
 * @param iso - The reset time, ISO 8601.
 */
export function formatResetTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(
    date
  );
}

/**
 * A window's name inside a sentence: `weekly`, `5-hour window`, or `usage` when unknown.
 *
 * @param window - The usage window's id.
 */
export function limitWindowPhrase(window: string): string {
  if (window === 'unknown') return 'usage';
  const label = windowLabel(window);
  return label.charAt(0).toLowerCase() + label.slice(1);
}
