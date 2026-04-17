import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Per-session runtime ownership. See ADR 0255.
// `createdAt` is ISO 8601 text for parity with every other table in this
// schema (a2a, activity, mesh, relay, tasks) — keeps ad-hoc `sqlite3` queries
// and cross-table joins uniform.
export const sessionMetadata = sqliteTable('session_metadata', {
  sessionId: text('session_id').primaryKey(),
  runtime: text('runtime').notNull(),
  agentPath: text('agent_path'),
  createdAt: text('created_at').notNull(),
});

export type SessionMetadata = typeof sessionMetadata.$inferSelect;
export type NewSessionMetadata = typeof sessionMetadata.$inferInsert;
