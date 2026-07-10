import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

// Durable per-session completed-turn event stream for LOG-BACKED runtimes
// (codex, opencode, test-mode). Claude-code does NOT write here — its transcript
// is SDK JSONL and its in-process EventLog is only gap-replay overflow (ADR-0309).
// One row per SessionEvent; `payload` is the full event as JSON (own the
// boundary, not the bytes — ADR-0263). `(session_id, seq)` is the natural PK and
// yields ordered range reads for free. Rows are written per completed turn and
// trimmed to the newest EVENT_LOG_MAX_EVENTS per session, mirroring the
// in-memory cap so reconstructable depth is approximately identical before and
// after a restart (approximately: the in-memory log also counts events that are
// never flushed here — see the sparseness note — so at the cap the store spans
// slightly more turns than the live log).
// The stored seq space is deliberately SPARSE: the projector stamps seq on
// every ingested event, but only turn events (turn_start … turn_end) are
// flushed — a non-turn event ingested outside a turn (e.g. a bare
// status_change) gets a seq yet never lands here. Harmless by design:
// `reconstructHistoryFromEvents` ignores such events anyway, and hydration
// restores the counter from MAX(seq), past any gap.
// `seq` is duplicated out of the payload for the PK / ordered reads / trim; the
// fold in `reconstructHistoryFromEvents` already discriminates on `event.type`,
// so no per-`type` column is needed. `created_at` is ISO 8601 text for parity
// with every other table in this schema.
export const sessionEvents = sqliteTable(
  'session_events',
  {
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.seq] }),
    bySession: index('session_events_session_idx').on(t.sessionId, t.seq),
  })
);

export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type NewSessionEventRow = typeof sessionEvents.$inferInsert;
