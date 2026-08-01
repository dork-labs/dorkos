import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Per-session operational metadata. The row carries two concerns with distinct
// write semantics:
//   1. Immutable identity (first-write-wins; ADR-0255) — which runtime owns the
//      session. Assigned once when the session actually starts, never updated.
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
  // NULL = this session has not started yet, so nothing has said which runtime
  // owns it. A settings change made before the first message creates the row
  // (that is E3's pre-launch picker), and a preference is not a binding: the
  // first turn carries the person's runtime choice and is what claims the row
  // (DOR-812). Readers resolve an unbound row exactly like a row-less one — by
  // inference, unpersisted — so nothing is blocked in the meantime.
  runtime: text('runtime'),
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
