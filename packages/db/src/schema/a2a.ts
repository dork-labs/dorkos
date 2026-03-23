import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * A2A (Agent-to-Agent) task state persistence.
 * Tracks inter-agent task lifecycle following the A2A protocol.
 */
export const a2aTasks = sqliteTable('a2a_tasks', {
  id: text('id').primaryKey(), // ULID
  contextId: text('context_id').notNull(),
  agentId: text('agent_id').notNull(),
  status: text('status', {
    enum: ['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'unknown'],
  }).notNull(),
  historyJson: text('history_json').notNull().default('[]'), // JSON array of Message objects
  artifactsJson: text('artifacts_json').notNull().default('[]'), // JSON array of Artifact objects
  metadataJson: text('metadata_json').notNull().default('{}'), // JSON object of task metadata
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
