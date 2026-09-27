import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * How full each session's context window was when it was last measured (spec
 * `claude-account-fleet` §6 U), so a session shows it the moment it opens and
 * after a restart, before any turn of its own.
 *
 * A table of its own rather than columns on `session_metadata`, on purpose:
 * opening a session writes here, and a `session_metadata` row created by an
 * open would carry no runtime, which `persistSessionRuntime` reads as a
 * conversation that already exists and would change how the first launch is
 * seeded. Written on each turn's terminal status and when a reading is
 * derived from the runtime's own record; moved by `rekeySessionSettings`.
 */
export const sessionContext = sqliteTable('session_context', {
  sessionId: text('session_id').primaryKey(),
  /** Tokens occupying the context window at the reading. */
  contextTokens: integer('context_tokens').notNull(),
  /** The model's context window at the reading; `0` when the runtime did not say. */
  contextMaxTokens: integer('context_max_tokens').notNull(),
  /** When the reading was taken (ISO-8601). */
  observedAt: text('observed_at').notNull(),
});

/** A stored context reading. */
export type SessionContextRow = typeof sessionContext.$inferSelect;
