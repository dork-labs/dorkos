/**
 * The arrival signal for a standing condition (DOR-1570).
 *
 * ## The gap this closes
 *
 * A standing kind writes NO row while it stands (ADR 260819-234828), so nothing
 * goes out on the `notification` channel until it ends. That is the right
 * storage discipline — the store that owns the condition already answers "is it
 * still waiting?" — but it left every surface that cannot poll a React Query
 * cache with no news at all. The React app derives parked schedules from its
 * `['tasks']` query and pending approvals from `approval_pending`; the Electron
 * main process has neither, so an agent could propose a schedule, or ask to
 * delete one, and the desktop app would show absolutely nothing (DOR-1570).
 *
 * So a standing condition now says once, on the wire, that it began standing.
 * That is all this is: an arrival, addressed to the operator, carrying a title,
 * a short body and a route — the same title and body the registry already
 * declares, so the periphery and the inbox cannot word one condition two ways.
 *
 * ## Not a toast, and not a second inbox
 *
 * Nothing here stores anything, and nothing here is a toast. The toast diet is
 * intentional (spec `notification-system` §6: feedback lives where your eyes
 * already are), and this event exists for the PERIPHERY — an OS banner, which
 * ADR 260819-234830 explicitly admits — not for a corner of the app the
 * operator is already looking at. The React app deliberately ignores it: it
 * already derives both conditions from state it holds.
 *
 * ## Why an Ask is not announced here
 *
 * `ask.pending` already has `interaction_pending`, which is richer: it names
 * the interaction that a banner's Allow / Deny / Reply buttons answer, and only
 * that event carries it. Announcing an Ask here as well would be two banners
 * for one condition. `session.error` is not announced either — it is out of
 * DOR-1570's scope, and the honest place to add it is here, in one line, when
 * somebody decides it earns a banner.
 *
 * @module services/notifications/standing-events
 */
import type {
  StandingPendingEvent,
  StandingResolvedEvent,
} from '@dorkos/shared/notification-schemas';
import { logger } from '../../lib/logger.js';
import { eventFanOut } from '../core/event-fan-out.js';
import { operatorAudience } from './notification-entitlement.js';
import {
  notificationEntry,
  resolvePerKind,
  type NotificationPayload,
  type StandingNotificationKind,
} from './notification-registry.js';
import { armEscalation, standingDeepLink } from './escalation-service.js';

/**
 * Announce that a blocking condition began standing, and start its escalation
 * clock.
 *
 * One call rather than two at each seam, because the two are the same moment
 * and splitting them is how one of them gets forgotten: the arrival is what
 * reaches somebody who is here, the clock is what reaches somebody who is not.
 *
 * **Never throws.** Every caller is a write that parked something — an MCP tool
 * handler, a route, the approval store — and none of them may fail because a
 * banner could not be announced.
 *
 * @param kind - Which standing kind.
 * @param payload - That kind's payload, which is what the banner will say.
 */
export function raiseStanding<K extends StandingNotificationKind>(
  kind: K,
  payload: NotificationPayload<K>
): void {
  try {
    const entry = notificationEntry(kind);
    const body = entry.body?.(payload);
    const event: StandingPendingEvent = {
      kind,
      subjectKey: entry.dedupeKey(payload),
      tier: resolvePerKind(entry.tier, payload),
      title: entry.title(payload),
      ...(body ? { body } : {}),
      deepLink: standingDeepLink(kind, payload),
      since: new Date().toISOString(),
    };
    eventFanOut.broadcast('standing_pending', event, operatorAudience);
  } catch (err) {
    logger.warn('[Notifications] Could not announce a standing condition', { err, kind });
  }
  // After the announcement, and outside its try: `armEscalation` has its own
  // guard, and a failure to draw a banner must not also cost the phone leg.
  armEscalation(kind, payload);
}

/**
 * Announce that a standing condition ended, so a surface retires what it drew.
 *
 * Says only which condition. Why it ended belongs to the history row (for the
 * kinds that write one) and to the store that owns the condition.
 *
 * Never throws, for the reason {@link raiseStanding} does not: the callers are
 * the answer paths, and a person answering must never see that fail.
 *
 * @param kind - Which standing kind ended.
 * @param subjectKey - The raising kind's `dedupeKey` — the same string the
 *   arrival carried and the escalation ladder filed its timer under.
 */
export function broadcastStandingResolved(
  kind: StandingNotificationKind,
  subjectKey: string
): void {
  try {
    const event: StandingResolvedEvent = {
      kind,
      subjectKey,
      resolvedAt: new Date().toISOString(),
    };
    eventFanOut.broadcast('standing_resolved', event, operatorAudience);
  } catch (err) {
    logger.warn('[Notifications] Could not announce a resolved standing condition', { err, kind });
  }
}
