/**
 * Small pieces of notification copy the registry's titles and bodies share:
 * dates and limit names, in the words a person reads.
 *
 * @module services/notifications/notification-copy
 */
import { windowLabel } from '@dorkos/shared/account-usage';
import type { NotificationPayload, NotificationRegistryEntry } from './notification-registry.js';

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

/**
 * How loud a pending approval is, and what it says (spread into the registry's
 * `approval.pending` entry).
 *
 * An ordinary approval is `blocking`: something irreversible is held until a
 * person decides, so the phone is pinged after a while. A passive one (DOR-3427,
 * `core/approvals/passive-approval.ts`) is `notable`: a package Full held back,
 * waiting under Needs you with nothing stopped behind it, so it never escalates,
 * and its words say so rather than "cannot be undone".
 */
export const APPROVAL_PENDING_COPY: Pick<
  NotificationRegistryEntry<'approval.pending'>,
  'tier' | 'title' | 'body'
> = {
  tier: (p) => (p.passive ? 'notable' : 'blocking'),
  title: (p) =>
    p.passive
      ? 'A package in a project is waiting for your OK'
      : `${p.requestedBy} needs your approval`,
  // The capability's TITLE and nothing else. The approval's own summary
  // carries the argument values an agent asked to run something with, and
  // this body reaches a lock screen and a Telegram thread — the card in the
  // app is where those belong.
  body: (p) =>
    p.passive
      ? `${p.capabilityTitle}? DorkOS did not install it. Nothing waits on your answer.`
      : `${p.capabilityTitle} cannot be undone, so it will not run until you decide.`,
};
