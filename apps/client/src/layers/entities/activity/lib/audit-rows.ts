/**
 * The audit log, read as activity rows.
 *
 * One mapping so the Activity page's "All actions" view and an agent's profile
 * timeline draw an audit event exactly the way they draw any other activity.
 *
 * @module entities/activity/lib/audit-rows
 */
import type { AuditActorKind, AuditEvent } from '@dorkos/shared/audit-schemas';
import { sessionHref } from '@/layers/shared/lib';
import type { ActivityRowItem, ActorType } from '../model/activity-types';

/**
 * The actor pill an audit actor wears.
 *
 * `external` is a person reaching this install from outside (Telegram, Slack),
 * so they wear a person's pill under their own name.
 */
const ACTOR_TYPE: Record<AuditActorKind, ActorType> = {
  person: 'user',
  external: 'user',
  agent: 'agent',
  system: 'system',
};

/**
 * Where an audit row opens: the chat it happened in.
 *
 * Only a session has a page to open. A relay trace has no route of its own in
 * the app, and no audit row names a room entry, so a row carrying neither
 * opens nothing rather than somewhere that cannot show it.
 *
 * @param event - The audit event.
 * @returns An app-relative path, or `null` when the row opens nothing.
 */
export function auditEventLinkPath(event: AuditEvent): string | null {
  return event.source.sessionId ? sessionHref({ session: event.source.sessionId }) : null;
}

/**
 * One audit event as the row the Activity feed draws.
 *
 * @param event - The audit event, as `GET /api/audit` returns it.
 */
export function auditEventToRow(event: AuditEvent): ActivityRowItem {
  return {
    id: event.id,
    occurredAt: event.at,
    actorType: ACTOR_TYPE[event.actor.kind],
    actorLabel: event.actor.name,
    summary: event.summary,
    linkPath: auditEventLinkPath(event),
  };
}
