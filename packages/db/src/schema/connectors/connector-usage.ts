/** Append-only connector execution attempt ledger. */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
} from './connections.js';

/** One provider attempt, excluding arguments, response data, and raw errors. */
export const connectorUsageAttempts = sqliteTable(
  'connector_usage_attempts',
  {
    attemptId: text('attempt_id').primaryKey(),
    logicalOperationId: text('logical_operation_id').notNull(),
    attemptIndex: integer('attempt_index').notNull(),
    surface: text('surface', { enum: ['mcp', 'rest', 'cli', 'event'] }).notNull(),
    actorKind: text('actor_kind', { enum: ['operator', 'agent', 'program', 'event'] }).notNull(),
    actorId: text('actor_id').notNull(),
    agentId: text('agent_id'),
    sessionId: text('session_id'),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id),
    providerInstanceId: text('provider_instance_id')
      .notNull()
      .references(() => connectorProviderInstances.id),
    providerType: text('provider_type').notNull(),
    payer: text('payer', { enum: ['operator_byo', 'dorkos_managed'] }).notNull(),
    operationRevisionId: text('operation_revision_id')
      .notNull()
      .references(() => connectorOperationRevisions.id),
    outcome: text('outcome').notNull(),
    providerLogId: text('provider_log_id'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    errorCode: text('error_code'),
  },
  (table) => [
    uniqueIndex('connector_usage_logical_attempt_unique').on(
      table.logicalOperationId,
      table.attemptIndex
    ),
    index('connector_usage_connection_started_idx').on(table.connectionId, table.startedAt),
    index('connector_usage_agent_started_idx').on(table.agentId, table.startedAt),
    index('connector_usage_revision_started_idx').on(table.operationRevisionId, table.startedAt),
  ]
);
