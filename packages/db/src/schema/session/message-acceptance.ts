import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Durable receipt for a private source accepted into a session's message queue.
 *
 * The receipt deliberately has no foreign key to the queue row: it is the
 * stable proof that survives queue deletion after a turn starts. Its source
 * identity is immutable and independent of dispatch attempts or process leases.
 */
export const sessionMessageAcceptanceReceipts = sqliteTable(
  'session_message_acceptance_receipts',
  {
    id: text('id').primaryKey(),
    sourceKind: text('source_kind', {
      enum: ['connector_agent_request', 'connector_event'],
    }).notNull(),
    sourceId: text('source_id').notNull(),
    sourceGeneration: text('source_generation').notNull(),
    queueMessageId: text('queue_message_id').notNull().unique(),
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id').notNull(),
    originRuntime: text('origin_runtime').notNull(),
    originAgentPath: text('origin_agent_path').notNull(),
    originAuthorityDigest: text('origin_authority_digest').notNull(),
    state: text('state', {
      enum: ['accepted', 'dispatching', 'turn_started', 'settled', 'cancelled', 'outcome_unknown'],
    }).notNull(),
    acceptedAt: text('accepted_at').notNull(),
    dispatchAttemptId: text('dispatch_attempt_id'),
    dispatchBootEpoch: text('dispatch_boot_epoch'),
    dispatchClaimedAt: text('dispatch_claimed_at'),
    turnStartSeq: integer('turn_start_seq'),
    turnStartedAt: text('turn_started_at'),
    settledAt: text('settled_at'),
    settleOutcome: text('settle_outcome', { enum: ['completed', 'failed'] }),
    cancellationCode: text('cancellation_code'),
  },
  (table) => [
    uniqueIndex('session_message_acceptance_source_unique').on(
      table.sourceKind,
      table.sourceId,
      table.sourceGeneration
    ),
    index('session_message_acceptance_state_idx').on(table.state, table.acceptedAt),
    index('session_message_acceptance_session_idx').on(
      table.sessionId,
      table.state,
      table.acceptedAt
    ),
  ]
);

export type SessionMessageAcceptanceReceipt = typeof sessionMessageAcceptanceReceipts.$inferSelect;
export type NewSessionMessageAcceptanceReceipt =
  typeof sessionMessageAcceptanceReceipts.$inferInsert;
