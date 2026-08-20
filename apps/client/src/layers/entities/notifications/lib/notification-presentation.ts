/**
 * How a notification draws, and where it goes when it is clicked.
 *
 * Kept out of the row components because three surfaces draw the same rows —
 * the bell's Activity list, an agent's profile, and home's activity group — and
 * a mark or a destination that disagreed between them would be the same event
 * telling two stories. Pure functions, so the mapping is a thing a test can
 * assert without mounting anything.
 *
 * @module entities/notifications/lib/notification-presentation
 */
import {
  Bell,
  CheckCircle2,
  CircleAlert,
  Clock,
  Download,
  Mail,
  MessageSquare,
  ShieldQuestion,
  Sparkles,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { NotificationDTO, NotificationKind } from '@dorkos/shared/notification-schemas';

/**
 * Where a notification row navigates.
 *
 * A route and its search params rather than a URL string, because that is what
 * TanStack Router takes and building the string by hand is how a deep link
 * quietly stops matching the route it was written for.
 */
export interface NotificationLink {
  /** The route path. */
  to: string;
  /** Its search params. */
  search: Record<string, unknown>;
}

/**
 * The mark drawn beside each kind of notification.
 *
 * A lookup table rather than a function, because a component reads it during
 * render: a capitalized binding assigned from a CALL is what
 * `react-hooks/static-components` reads as "a component defined in render", and
 * it is right to — the record makes the icon a value the row looks up rather
 * than one it appears to mint.
 */
export const NOTIFICATION_ICONS: Record<NotificationKind, LucideIcon> = {
  'ask.pending': ShieldQuestion,
  'schedule.parked': Clock,
  'session.error': CircleAlert,
  'turn.completed': CheckCircle2,
  'run.completed': CheckCircle2,
  'dm.received': MessageSquare,
  'mention.received': MessageSquare,
  'agent.note': Bell,
  'dead-letter.created': Mail,
  'agent.unreachable': WifiOff,
  'update.installed': Download,
  'report.daily': Sparkles,
};

/**
 * How loudly a notification draws.
 *
 * Read off the TIER, not the kind, because the tier is the one knob the registry
 * says decides loudness — and it is the only place `run.completed` says whether
 * this particular run failed. A quiet row is drawn as news, never as an alarm.
 *
 * @param notification - The row.
 */
export function notificationTone(notification: NotificationDTO): 'error' | 'warning' | 'neutral' {
  if (notification.tier === 'blocking') return 'error';
  if (notification.tier === 'notable') return 'warning';
  return 'neutral';
}

/**
 * A failed run reads as an error even though its tier is only `notable`.
 *
 * The one place tone and tier part company, and it is deliberate: `run.completed`
 * carries both outcomes under one kind, and `notable` is exactly how the registry
 * spells "this one failed" (a success is `quiet`). See the registry entry.
 *
 * @param notification - The row.
 */
export function isFailedRun(notification: NotificationDTO): boolean {
  return notification.kind === 'run.completed' && notification.tier === 'notable';
}

/**
 * Where clicking a notification goes.
 *
 * Three of these land on home's detail sheets rather than on a page, and that is
 * the contract this had to preserve: `/?detail=failed-run&itemId=…` and its two
 * siblings are addresses people have pasted to each other since long before the
 * Inbox existed, and they still open the same sheet.
 *
 * **The one that could not be preserved is a dead letter's.** That sheet is keyed
 * by the aggregated `source::reason` GROUP, while a notification's subject is the
 * single relay MESSAGE that failed — the group key is not derivable from it. So a
 * dead-letter row opens the Relay page, which lists every group in full, rather
 * than a sheet that would greet it with "this item has been resolved".
 *
 * Returns `null` for a notification with nowhere to go (an update record), and
 * the row then draws as text rather than as a dead button.
 *
 * @param notification - The row that was clicked.
 */
export function notificationLink(notification: NotificationDTO): NotificationLink | null {
  const { subject, kind, sessionId } = notification;

  if (kind === 'agent.unreachable') {
    return { to: '/', search: { detail: 'offline-agent', itemId: subject.id } };
  }
  if (kind === 'dead-letter.created') {
    return { to: '/connections', search: {} };
  }
  if (kind === 'update.installed' || kind === 'report.daily') {
    return null;
  }

  switch (subject.type) {
    case 'session':
      return { to: '/session', search: { session: subject.id } };
    case 'run':
      return { to: '/', search: { detail: 'failed-run', itemId: subject.id } };
    case 'task':
      return { to: '/tasks', search: {} };
    case 'room':
      // `?id=`, which is how every other link to a room is spelled — the route
      // carries a room's identity as a search param, not a path segment.
      return { to: '/channels', search: { id: subject.id } };
    case 'agent':
      // An agent's note is about a conversation when it had one, and about the
      // agent otherwise. The session is the more useful of the two: it is where
      // the note came from and where an answer would go.
      return sessionId === undefined
        ? { to: '/team', search: {} }
        : { to: '/session', search: { session: sessionId } };
    default:
      return null;
  }
}
