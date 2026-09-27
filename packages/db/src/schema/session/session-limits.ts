import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * A hard usage limit a session's account reported during its last turn (spec
 * `claude-account-fleet` D4), kept so it outlives the process.
 *
 * Claude Code's projector records only a few event types and never hydrates
 * status, so a limit held only in memory vanished at a restart or an idle
 * eviction, and the session went back to looking merely failed. One row per
 * session: written when a limit is set and on every plan or state change,
 * deleted at that session's next `turn_start`, moved with the session's rekey.
 *
 * `plan` is the JSON of a `LimitPlan` (`packages/shared/src/schemas.ts`); every
 * time column is ISO 8601 text, like the rest of this schema.
 */
export const sessionLimits = sqliteTable('session_limits', {
  /** The canonical session id. */
  sessionId: text('session_id').primaryKey(),
  /** When the limit was hit. */
  since: text('since').notNull(),
  /** The ledger window key that rejected work, such as `five_hour`, or `unknown`. */
  window: text('window').notNull(),
  /** Whether the whole account ran out (`account`) or one model's window (`model`). */
  scope: text('scope', { enum: ['account', 'model'] }).notNull(),
  /** When the window resets, or NULL when unknown. */
  resetsAt: text('resets_at'),
  /** The registry id of the account, or NULL when its folder is not registered. */
  accountId: text('account_id'),
  /** The Claude config folder the session ran in, or NULL when unknown. */
  accountPath: text('account_path'),
  /** What happens next, as `LimitPlan` JSON. */
  plan: text('plan').notNull(),
  /** Where the limit stands; `limited` until the out-of-usage flow computes more. */
  state: text('state').notNull(),
  /** The row's last write. */
  updatedAt: text('updated_at').notNull(),
});

/** A row of {@link sessionLimits}. */
export type SessionLimitRow = typeof sessionLimits.$inferSelect;
/** An insertable row of {@link sessionLimits}. */
export type NewSessionLimitRow = typeof sessionLimits.$inferInsert;
