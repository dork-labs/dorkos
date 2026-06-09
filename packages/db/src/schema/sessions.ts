import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Per-session operational metadata. The row carries two concerns with distinct
// write semantics:
//   1. Immutable identity (first-write-wins; ADR-0255) — which runtime owns the
//      session. Assigned once at creation, never updated.
//   2. Mutable per-session settings (last-write-wins; ADR-0260) — the operator's
//      chosen permission mode, model, effort, and fast toggle. Persisted so
//      they survive idle eviction and server restart. NULL = "no explicit
//      preference; use the runtime's default."
// `createdAt` is ISO 8601 text for parity with every other table in this
// schema (a2a, activity, mesh, relay, tasks) — keeps ad-hoc `sqlite3` queries
// and cross-table joins uniform.
export const sessionMetadata = sqliteTable('session_metadata', {
  // --- Immutable identity (first-write-wins; ADR-0255) ---
  sessionId: text('session_id').primaryKey(),
  runtime: text('runtime').notNull(),
  agentPath: text('agent_path'),
  createdAt: text('created_at').notNull(),
  // --- Mutable per-session settings (last-write-wins; ADR-0260) ---
  // NULL = "no explicit preference; use the runtime's default."
  permissionMode: text('permission_mode'),
  model: text('model'),
  effort: text('effort'),
  fastMode: integer('fast_mode', { mode: 'boolean' }),
});

export type SessionMetadata = typeof sessionMetadata.$inferSelect;
export type NewSessionMetadata = typeof sessionMetadata.$inferInsert;
