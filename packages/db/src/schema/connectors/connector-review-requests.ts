/** Durable connector operator review and private agent-resume schema. */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** General, validated operator mutation request. */
export const connectorReviewRequests = sqliteTable(
  'connector_review_requests',
  {
    id: text('id').primaryKey(),
    actionKind: text('action_kind').notNull(),
    actionVersion: integer('action_version').notNull(),
    requesterKind: text('requester_kind', { enum: ['agent', 'program', 'operator'] }).notNull(),
    requesterId: text('requester_id').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    actionPayloadJson: text('action_payload_json').notNull(),
    state: text('state', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull(),
    expiresAt: text('expires_at').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by'),
    resolutionSummary: text('resolution_summary'),
  },
  (table) => [
    uniqueIndex('connector_review_request_idempotency_unique').on(
      table.requesterKind,
      table.requesterId,
      table.idempotencyKey
    ),
    index('connector_review_requests_state_idx').on(table.state, table.expiresAt),
  ]
);

/** Private agent intent and resume state linked to an operator review. */
export const connectorAgentRequests = sqliteTable(
  'connector_agent_requests',
  {
    id: text('id').primaryKey(),
    reviewRequestId: text('review_request_id')
      .notNull()
      .unique()
      .references(() => connectorReviewRequests.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull(),
    serviceSlug: text('service_slug').notNull(),
    requestedOperationsJson: text('requested_operations_json').notNull(),
    requestedEventsJson: text('requested_events_json').notNull(),
    reason: text('reason').notNull(),
    resumeState: text('resume_state', {
      enum: ['pending', 'ready', 'resumed', 'expired'],
    }).notNull(),
    resumeToken: text('resume_token').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('connector_agent_requests_agent_idx').on(table.agentId, table.sessionId),
    index('connector_agent_requests_resume_idx').on(
      table.resumeState,
      table.sessionId,
      table.serviceSlug
    ),
  ]
);
