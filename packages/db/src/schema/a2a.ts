import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * A2A (Agent-to-Agent) task state persistence.
 * Tracks inter-agent task lifecycle following the A2A protocol.
 */
export const a2aTasks = sqliteTable('a2a_tasks', {
  id: text('id').primaryKey(), // ULID
  contextId: text('context_id').notNull(),
  agentId: text('agent_id').notNull(),
  // The A2A v0.3 spelling of each task state, which is the readable one and
  // the one already on disk. The protocol's v1.0 model numbers these states
  // instead; `taskStateToDbStatus` in @dorkos/a2a-gateway is where the two
  // meet. Drizzle's `enum` is a TypeScript narrowing only — the column is
  // plain `text` with no CHECK — so this list can grow without a migration.
  status: text('status', {
    enum: [
      'submitted',
      'working',
      'input-required',
      'auth-required',
      'completed',
      'canceled',
      'failed',
      'rejected',
      'unknown',
    ],
  }).notNull(),
  historyJson: text('history_json').notNull().default('[]'), // JSON array of Message objects
  artifactsJson: text('artifacts_json').notNull().default('[]'), // JSON array of Artifact objects
  metadataJson: text('metadata_json').notNull().default('{}'), // JSON object of task metadata
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
