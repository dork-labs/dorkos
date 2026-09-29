import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * How each of a session's usage-limit episodes ended (spec `claude-account-ui`
 * §7.1), so the transcript can still say what happened after the session's
 * `session_limits` row is gone.
 *
 * `session_limits` holds one live episode and is deleted at the session's next
 * `turn_start`. One row here per resolved episode, written by the same store
 * that owns `session_limits` in the same statement path, so the two cannot
 * disagree: a `moved` row when the plan becomes `continued`, and a `resumed-*`
 * row when the limit row is deleted without one. Unique on
 * (`session_id`, `since`): a second write for an episode is ignored. Moved with
 * the session's rekey; rows older than 30 days are swept at boot.
 *
 * Every time column is ISO 8601 text, like the rest of this schema.
 */
export const sessionLimitHistory = sqliteTable(
  'session_limit_history',
  {
    /** A uuid. */
    id: text('id').primaryKey(),
    /** The canonical session id the limit hit. */
    sessionId: text('session_id').notNull(),
    /** When the limit was hit (the episode's `session_limits.since`). */
    since: text('since').notNull(),
    /** The runtime the session ran on, such as `claude-code`. */
    runtime: text('runtime').notNull(),
    /** The registry id of the account that ran out, or NULL when unregistered. */
    accountId: text('account_id'),
    /** The ledger window key that rejected work, such as `five_hour`. */
    window: text('window').notNull(),
    /** Whether the whole account ran out (`account`) or one model's window (`model`). */
    scope: text('scope').notNull(),
    /** When that window resets, or NULL when unknown. */
    resetsAt: text('resets_at'),
    /** How the episode ended. */
    resolution: text('resolution', {
      enum: ['moved', 'resumed-reset', 'resumed-model', 'resumed-early'],
    }).notNull(),
    /** When it ended. */
    resolvedAt: text('resolved_at').notNull(),
    /** The session the work carried over to (`moved` only). */
    toSessionId: text('to_session_id'),
    /** The account the work carried over to (`moved` only). */
    toAccountId: text('to_account_id'),
    /** The model before a `resumed-model` switch. */
    modelFrom: text('model_from'),
    /** The model after a `resumed-model` switch. */
    modelTo: text('model_to'),
  },
  (table) => [
    uniqueIndex('session_limit_history_episode_idx').on(table.sessionId, table.since),
    index('session_limit_history_resolved_at_idx').on(table.resolvedAt),
  ]
);

/** A row of {@link sessionLimitHistory}. */
export type SessionLimitHistoryRow = typeof sessionLimitHistory.$inferSelect;
/** An insertable row of {@link sessionLimitHistory}. */
export type NewSessionLimitHistoryRow = typeof sessionLimitHistory.$inferInsert;
