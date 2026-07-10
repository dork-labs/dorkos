import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

// Durable per-session completed-turn event stream for LOG-BACKED runtimes
// (codex, opencode, test-mode). Claude-code does NOT write here — its transcript
// is SDK JSONL and its in-process EventLog is only gap-replay overflow (ADR-0309).
// One row per SessionEvent; `payload` is the full event as JSON (own the
// boundary, not the bytes — ADR-0263). `(session_id, seq)` is the natural PK and
// yields ordered range reads for free. Rows are written per completed turn and
// trimmed to the newest EVENT_LOG_MAX_EVENTS per session, matching the in-memory
// cap so reconstructable depth is identical before and after a restart.
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
