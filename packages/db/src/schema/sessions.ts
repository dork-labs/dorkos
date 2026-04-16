import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Per-session runtime ownership. See ADR 0255.
export const sessionMetadata = sqliteTable('session_metadata', {
  sessionId: text('session_id').primaryKey(),
  runtime: text('runtime').notNull(),
  agentPath: text('agent_path'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type SessionMetadata = typeof sessionMetadata.$inferSelect;
export type NewSessionMetadata = typeof sessionMetadata.$inferInsert;
