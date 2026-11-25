/**
 * Small pieces of notification copy the registry's titles and bodies share:
 * dates, limit names and what to call a chat, in the words a person reads;
 * and the "finished" row's payload and identity, which the run record's
 * outbox writes too.
 *
 * @module services/notifications/notification-copy
 */
import path from 'node:path';
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
      : p.spend
        ? `${p.requestedBy} wants to run a paid action`
        : `${p.requestedBy} needs your approval`,
  // The capability's TITLE and nothing else. The approval's own summary
  // carries the argument values an agent asked to run something with, and
  // this body reaches a lock screen and a Telegram thread — the card in the
  // app is where those belong.
  body: (p) =>
    p.passive
      ? `${p.capabilityTitle}? DorkOS did not install it. Nothing waits on your answer.`
      : p.spend
        ? // A paid run is answered only in the app (spec 1.1): no yes from a chat.
          `${p.capabilityTitle} spends money. Answer in DorkOS.`
        : `${p.capabilityTitle} cannot be undone, so it will not run until you decide.`,
};

/**
 * What to call a session in a sentence.
 *
 * The working directory's last segment, which is the identity fallback every
 * other session surface uses. A notification title has to stand on its own in a
 * desktop banner or a chat message, so it cannot be an id.
 *
 * @param cwd - The session's working directory, when the projector knew one.
 */
export function sessionLabelFor(cwd: string | undefined): string {
  if (!cwd) return 'A chat';
  return path.basename(cwd) || 'A chat';
}

/** A turn finished. */
export interface TurnCompletedPayload {
  sessionId: string;
  agentId?: string;
  /** What to call the session in a sentence. See `ask.pending`. */
  sessionLabel: string;
  /** When it finished. ISO 8601 UTC — also what keeps two turns distinct. */
  completedAt: string;
  /** The turn's run, when the outbox told it (spec `turns-survive-restarts` §6.4). */
  runId?: string;
}

/**
 * What makes two "finished" rows the same. A run's is the outbox's own key,
 * unique for good (`notify:<runId>:completed`, §6.4); a turn with no run (a
 * task's or a relay's, until they reach the dispatcher) keeps its time.
 *
 * @param p - The payload.
 */
export function turnCompletedDedupeKey(p: TurnCompletedPayload): string {
  return p.runId ? `notify:${p.runId}:completed` : `turn:${p.sessionId}:${p.completedAt}`;
}
