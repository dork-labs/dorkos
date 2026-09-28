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
  /** Where the limit stands (`LimitState`); `limited` until the out-of-usage flow computes more. */
  state: text('state').notNull(),
  /** The session's working directory when the limit was hit, or NULL when unknown. */
  cwd: text('cwd'),
  /** The model the same account can keep going on when only one model ran out, or NULL. */
  modelFallback: text('model_fallback'),
  /** With `all-accounts-out`: the JSON of `{ accountId, resetsAt }` for the earliest reset, or NULL. */
  allOut: text('all_out'),
  /**
   * The extension id of the account advisor that claimed this session (spec
   * `claude-account-fleet` X, "One writer for a flow run"), or NULL when none
   * did. Stored rather than asked live, so a claim survives the advisor's
   * extension reloading.
   */
  claimedBy: text('claimed_by'),
  /**
   * The session's chosen model when the limit was hit (`session_metadata.model`),
   * `''` for the runtime's default, or NULL when never recorded (unknown, never
   * read as a switch). What the limit history compares against at the next
   * `turn_start` to tell a model switch from a wait (spec `claude-account-ui`
   * §7.1). Migration 0120 backfilled the rows that predate it.
   */
  model: text('model'),
  /** The row's last write. */
  updatedAt: text('updated_at').notNull(),
});

/** A row of {@link sessionLimits}. */
export type SessionLimitRow = typeof sessionLimits.$inferSelect;
/** An insertable row of {@link sessionLimits}. */
export type NewSessionLimitRow = typeof sessionLimits.$inferInsert;
