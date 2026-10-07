/**
 * Every Activity event lands in the audit log too (spec `audit-trail` §3.5).
 *
 * The audit log is the superset: the Activity feed stays the plain-language
 * summary people scroll, and each row it writes is copied here with a stable
 * actor id and a link back (`links.activityId`). It rides
 * `ActivityService.observe`, which calls observers only after the Activity write
 * committed, so the audit row never describes something the feed failed to keep.
 *
 * ## One or the other, never both
 *
 * A choke point records an action EITHER by writing Activity (and gets its audit
 * row through this tee) OR by calling `AuditLog.record` directly. Doing both
 * would record one action twice. `contributing/audit-trail.md` states the rule.
 *
 * ## What the feed does not say
 *
 * An Activity row carries no surface and no operation, so both are inferred:
 * the surface is `system` ("recorded by DorkOS; where it came in is not
 * known"), and the operation and outcome are read off the event's verb
 * ({@link operationFor}, {@link outcomeFor}). A session id in the row's metadata
 * is carried across so the event links to its transcript.
 *
 * @module services/audit/activity-tee
 */
import type { ActivityItem } from '@dorkos/shared/activity-schemas';
import type { AuditActor, AuditOperation, AuditOutcome } from '@dorkos/shared/audit-schemas';
import type { ActivityObserver } from '../activity/activity-service.js';
import { UNIDENTIFIED_ACTOR_LABEL } from '../activity/activity-actor.js';
import type { AuditLog } from './audit-log.js';
import type { AccountIds } from './account-ids.js';

/** Verbs that bring something into being. */
const CREATE_VERBS = /(?:^|_)(?:created|registered|added|installed|started|minted)$/;
/** Verbs that take something away. */
const REMOVE_VERBS = /(?:^|_)(?:deleted|removed|unregistered|uninstalled|revoked|cancelled)$/;
/** Verbs that run something rather than change it. */
const EXECUTE_VERBS = /(?:^run_|(?:^|_)(?:invoked|delivered|continued|reloaded|ran)$)/;

/**
 * The broad operation an Activity event type describes, read off its verb.
 *
 * @param eventType - `domain.verb`.
 */
export function operationFor(eventType: string): AuditOperation {
  const verb = eventType.slice(eventType.indexOf('.') + 1);
  // A run's verbs come first: `run_cancelled` is a run that stopped, not a
  // thing that was removed.
  if (EXECUTE_VERBS.test(verb)) return 'execute';
  if (CREATE_VERBS.test(verb)) return 'create';
  if (REMOVE_VERBS.test(verb)) return 'remove';
  return 'modify';
}

/**
 * How an Activity event came out, read off its verb.
 *
 * @param eventType - `domain.verb`.
 */
export function outcomeFor(eventType: string): AuditOutcome {
  const verb = eventType.slice(eventType.indexOf('.') + 1);
  if (/(?:failed|failure|error)/.test(verb)) return 'failed';
  if (/(?:refused|denied)/.test(verb)) return 'refused';
  return 'ok';
}

/** The stable actor for an Activity row's actor fields. */
function actorFor(event: ActivityItem, ids: AccountIds): AuditActor {
  switch (event.actorType) {
    case 'user':
      return event.actorId ? ids.person(event.actorId, event.actorLabel) : ids.owner();
    case 'agent':
      return event.actorId
        ? ids.agent(event.actorId, event.actorLabel)
        : ids.unidentified(event.actorLabel);
    case 'system':
      return event.actorLabel === UNIDENTIFIED_ACTOR_LABEL
        ? ids.unidentified(event.actorLabel)
        : ids.system(event.actorLabel);
    case 'tasks':
      return ids.system(event.actorLabel);
  }
}

/**
 * Build the observer that copies each Activity event into the audit log.
 *
 * @param log - The audit log.
 * @param ids - The account-id resolver.
 * @returns An observer for `ActivityService.observe`.
 */
export function createActivityTee(log: AuditLog, ids: AccountIds): ActivityObserver {
  return (event) => {
    const sessionId = event.metadata?.sessionId;
    const targetId =
      event.resourceId && event.resourceType === 'agent'
        ? ids.agentAccountId(event.resourceId)
        : event.resourceId;
    log.record({
      at: event.occurredAt,
      actor: actorFor(event, ids),
      source: {
        surface: 'system',
        ...(typeof sessionId === 'string' ? { sessionId } : {}),
      },
      action: event.eventType,
      operation: operationFor(event.eventType),
      target:
        event.resourceType && targetId
          ? {
              type: event.resourceType,
              id: targetId,
              ...(event.resourceLabel ? { name: event.resourceLabel } : {}),
            }
          : null,
      outcome: outcomeFor(event.eventType),
      links: { activityId: event.id },
      summary: event.summary,
    });
  };
}
