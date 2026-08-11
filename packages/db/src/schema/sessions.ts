import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

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

// A message somebody typed while the session was busy, waiting its turn. The
// SERVER owns the queue (spec `persistent-session-runtime` §3.1), and it is
// persisted for one reason: ADR-0264 accepts losing an in-flight TURN on
// restart, but a message a person was told was accepted is a different and
// worse promise to break — the loss DOR-480 already ruled unacceptable. Rows
// therefore survive a refresh, a second window, a failed turn, and a restart.
//
// `position` is SPARSE (the store steps by 1000) so a reorder is an UPDATE of
// one row rather than a rewrite of every row in the session; the store
// renumbers only when a gap between two neighbours has closed.
//
// `session_id` is the CANONICAL session id, which a brand-new session does not
// have until mid-first-turn — the rows are written under the request UUID and
// moved with the same rebind that moves the `session_metadata` row above. A
// queue left behind at the old key is invisible forever.
//
// `enqueued_at` is epoch ms rather than the ISO 8601 text the rest of this
// schema uses, and deliberately so: it is a WIRE field. `QueuedMessage`
// (packages/shared) types `enqueuedAt` as a number on the SSE contract, so text
// here would mean a parse on every read of a hot path and a second
// representation of the same instant to keep honest.
//
// `disposition` is what the sender REQUESTED, never what was applied — what
// actually happened is a `MessageDeliveryOutcome` on the stream, not a stored
// fact. The enum is a storage-side narrowing for the query types; the
// authoritative definition is `MessageDispositionSchema` in @dorkos/shared, and
// the store's row-to-`QueuedMessage` mapping fails to compile if the two drift.
export const sessionMessageQueue = sqliteTable(
  'session_message_queue',
  {
    // The messageId: server-minted, and the id every delivery outcome
    // correlates on (correlation is by id and never positional).
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    position: integer('position').notNull(),
    // The person's words, pristine — context assembly never mutates them.
    content: text('content').notNull(),
    disposition: text('disposition', { enum: ['queue', 'steer', 'stage'] }).notNull(),
    // Who enqueued it, so a window can tell its own chips from another's.
    clientId: text('client_id').notNull(),
    enqueuedAt: integer('enqueued_at').notNull(),
    // The `ClientContext` captured at enqueue time, JSON. NULL = none was sent.
    contextJson: text('context_json'),
  },
  (t) => ({
    // (session_id, position) rather than session_id alone: every read of this
    // table is one session's queue in order, so the index serves the ORDER BY
    // as well as the filter.
    bySession: index('session_message_queue_session_idx').on(t.sessionId, t.position),
  })
);

export type SessionMessageQueueRow = typeof sessionMessageQueue.$inferSelect;
export type NewSessionMessageQueueRow = typeof sessionMessageQueue.$inferInsert;
