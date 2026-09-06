/** Append-only connector execution intent and terminal receipt ledger. */
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
    actorKind: text('actor_kind', {
      enum: ['operator', 'agent', 'program', 'event', 'runtime'],
    }).notNull(),
    actorId: text('actor_id').notNull(),
    ownerKind: text('owner_kind', { enum: ['user', 'local_install'] }),
    ownerId: text('owner_id'),
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
    startedAt: text('started_at').notNull(),
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

/** Append-only terminal evidence for one immutable execution intent. */
export const connectorUsageTerminalReceipts = sqliteTable(
  'connector_usage_terminal_receipts',
  {
    receiptId: text('receipt_id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .unique()
      .references(() => connectorUsageAttempts.attemptId),
    outcome: text('outcome', {
      enum: ['success', 'error', 'cancelled', 'outcome_unknown', 'unsupported'],
    }).notNull(),
    providerLogId: text('provider_log_id'),
    errorCode: text('error_code'),
    /** Original P1 outcome vocabulary when a migration had to map it conservatively. */
    sourceOutcome: text('source_outcome'),
    completedAt: text('completed_at'),
    recordedAt: text('recorded_at').notNull(),
    provenance: text('provenance', {
      enum: ['broker', 'managed_provider', 'migrated_p1', 'startup_recovery'],
    }).notNull(),
  },
  (table) => [index('connector_usage_receipts_recorded_idx').on(table.recordedAt)]
);
