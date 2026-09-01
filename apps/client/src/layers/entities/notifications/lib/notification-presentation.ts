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
  LogIn,
  Mail,
  MessageSquare,
  ShieldQuestion,
  Sparkles,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { NotificationDTO, NotificationKind } from '@dorkos/shared/notification-schemas';

/**
 * The Settings tab that holds every runtime's sign-in.
 *
 * Spelled here as well as in `ErrorMessageBlock` because the two live in
 * different FSD layers (an entity may not import from a feature) and this is one
 * short string, not shared logic worth a `shared/` home of its own.
 */
const RUNTIMES_SETTINGS_TAB = 'runtimes';

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
  // Reserved: a capability approval keeps its history in the `approvals` table,
  // so no row of this kind is ever stored today (DOR-1570). The entry exists
  // because this record is exhaustive over `NotificationKind` — which is what
  // makes a future emitter a compile error here rather than a blank icon.
  'approval.pending': ShieldQuestion,
  'session.error': CircleAlert,
  'turn.completed': CheckCircle2,
  'run.completed': CheckCircle2,
  'dm.received': MessageSquare,
  'mention.received': MessageSquare,
  'agent.note': Bell,
  'dead-letter.created': Mail,
  'agent.unreachable': WifiOff,
  'signin.required': LogIn,
  'update.installed': Download,
  'report.daily': Sparkles,
};

/** How loudly a notification draws. */
export type NotificationTone = 'error' | 'warning' | 'neutral';

/**
 * How loudly a notification draws.
 *
 * Read off the TIER, not the kind, because the tier is the one knob the registry
 * says decides loudness — and it is the only place `run.completed` says whether
 * this particular run failed. A quiet row is drawn as news, never as an alarm.
 *
 * @param notification - The row.
 */
export function notificationTone(notification: NotificationDTO): NotificationTone {
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
 * The tone a ROW draws in, folding {@link isFailedRun} over {@link notificationTone}.
 *
 * Every drawer of a row wants this composite, not the tier reading alone —
 * `InboxRow` did the same two-line fold inline, and the burst-coalescing fold
 * needs the identical answer to decide whether two adjacent rows are the same
 * story (see `features/inbox/lib/group-activity-rows`). One function so the
 * two can never drift apart.
 *
 * @param notification - The row.
 */
export function notificationRowTone(notification: NotificationDTO): NotificationTone {
  return isFailedRun(notification) ? 'error' : notificationTone(notification);
}

/**
 * Kinds a burst can actually form around.
 *
 * Verified against every server emitter under
 * `apps/server/src/services/notifications/emitters/` (and the one inline
 * `notify()` call in `apps/server/src/index.ts` for `dead-letter.created`).
 * `update.installed` and `report.daily` are excluded structurally — their
 * payload TYPE carries no `agentId` field at all, optional or otherwise, so
 * {@link groupActivityRows} (which requires an `agentId` to fold rows at all)
 * can never build a group of them.
 *
 * `ask.pending`, `session.error` and `dead-letter.created` are excluded
 * DESPITE now carrying `agentId` (DOR-1408 wired all three): grouping is a
 * separate decision from attribution, made here and not automatically earned
 * by a payload field. The first two are drawn in the `error` tone regardless
 * (`notificationRowTone`), so `InboxRow` never draws a face for them either —
 * folding three of a kind that never shows a face into "Alpha Bot hit 3
 * errors" would trade the ability to scan each one for a summary line, which
 * is the wrong trade for the loudest tier the registry has. `dead-letter.created`
 * DOES draw a face when its sender resolves (`quiet`/`neutral` tone), but
 * stays out of the grouping list on its own, smaller-volume merits — nothing
 * here forces it to stay excluded going forward.
 *
 * Not inferred from the payload TYPE's `agentId?: string` for exactly this
 * reason: a kind gaining the field is attribution, not an automatic license
 * to summarize its rows. A named list, checked against behaviour AND product
 * intent, is the only honest source of truth here.
 */
const GROUPABLE_KINDS = [
  'schedule.parked',
  'turn.completed',
  'run.completed',
  'dm.received',
  'mention.received',
  'agent.note',
  'agent.unreachable',
] as const;

/** A kind whose rows can fold into a burst — see {@link GROUPABLE_KINDS}. */
export type GroupableNotificationKind = (typeof GROUPABLE_KINDS)[number];

/**
 * Whether a kind can ever head a burst.
 *
 * A type guard, not a cast: `groupActivityRows` narrows a notification's
 * `kind` through this before it ever reaches {@link notificationBurstVerb},
 * so a future emitter that starts setting `agentId` on a kind not yet listed
 * here degrades to "stays ungrouped" rather than throwing the moment three of
 * them land.
 *
 * @param kind - The kind to test.
 */
export function isGroupableKind(kind: NotificationKind): kind is GroupableNotificationKind {
  return (GROUPABLE_KINDS as readonly NotificationKind[]).includes(kind);
}

/**
 * The phrase a burst of `count` consecutive same-agent, same-kind rows reads
 * as once collapsed — "finished 4 runs", not the singular row's own title,
 * because the individual titles ("alpha finished") do not compose past one.
 *
 * Exhaustive over {@link GroupableNotificationKind} by construction (a
 * `Record` over that union, not a fallback default): a groupable kind added
 * without an entry here is a type error at this file, not a blank group
 * header at runtime.
 *
 * @param kind - The shared kind every row in the burst carries.
 * @param count - How many rows collapsed into it. Every phrase below is
 *   hard-plural ("4 runs") because the fold that builds a burst
 *   (`features/inbox/lib/group-activity-rows`) never calls this below its own
 *   three-row threshold — the grammar leans on that invariant, it does not
 *   duck it.
 */
export function notificationBurstVerb(kind: GroupableNotificationKind, count: number): string {
  return BURST_VERB[kind](count);
}

/** The verb phrase per groupable kind that {@link notificationBurstVerb} looks up. */
const BURST_VERB: Record<GroupableNotificationKind, (count: number) => string> = {
  'schedule.parked': (n) => `proposed ${n} scheduled tasks`,
  'turn.completed': (n) => `finished ${n} turns`,
  'run.completed': (n) => `finished ${n} runs`,
  'dm.received': (n) => `sent ${n} messages`,
  'mention.received': (n) => `mentioned you ${n} times`,
  'agent.note': (n) => `left ${n} notes`,
  'agent.unreachable': (n) => `went offline ${n} times`,
};

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
  if (kind === 'signin.required') {
    // Settings → Runtimes, which is where signing in again actually happens —
    // the same destination the chat's own "Fix sign-in" button opens
    // (`features/chat/ui/message/ErrorMessageBlock.tsx`). Its subject type is
    // `system`, so without this the switch below would send it nowhere and the
    // one row in the inbox that has something to DO would draw as plain text.
    return { to: '/', search: { settings: RUNTIMES_SETTINGS_TAB } };
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
