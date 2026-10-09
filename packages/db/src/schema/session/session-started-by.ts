import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Who started a chat, when it was not a person typing into it (spec
 * `flow-multiproject` §7.7, D13): an extension (`api.startWork`,
 * `ctx.sessions.start`) or another chat (the `session_start` tool).
 *
 * One row per started chat, written before its first message is sent and
 * removed again when the launch is refused. It is what the chat's first line
 * ("Started by Flow: 12 new ideas were waiting to be sorted") is drawn from,
 * and it is also the counter for an extension's start limits, which is why the
 * count lives here and not in memory: a restart must not reset it.
 *
 * `origin_extension_id` is the extension at the root of the chain: itself for
 * `kind = 'extension'`, inherited from the parent chat for `kind = 'chat'`, and
 * NULL for a chat whose chain reaches no extension. Chats started from an
 * extension's chats count against that extension's limits through it.
 *
 * Rows are kept for as long as the chat: they are what folds its prompt,
 * what a `watch` checks, and what keeps its chats inside the limits.
 */
export const sessionStartedBy = sqliteTable(
  'session_started_by',
  {
    /** The started chat's canonical id. */
    sessionId: text('session_id').primaryKey(),
    /** What started it. */
    kind: text('kind', { enum: ['extension', 'chat'] }).notNull(),
    /** The extension that started it, for `kind = 'extension'`. */
    extensionId: text('extension_id'),
    /** The chat that started it, for `kind = 'chat'`. */
    startedBySessionId: text('started_by_session_id'),
    /** The extension at the root of the chain, or NULL when none. */
    originExtensionId: text('origin_extension_id'),
    /** Why it was started, in plain words (≤ 200), or NULL when none was given. */
    reason: text('reason'),
    /**
     * A chat carried to another account from a started one (a move, not new
     * work): it keeps the chain, and it is never refused by, nor counted in,
     * the hourly limit.
     */
    carried: integer('carried', { mode: 'boolean' }).notNull().default(false),
    /**
     * The permission mode a `kind = 'chat'` start was granted, on its own
     * runtime (spec `inherited-start-permission`). NULL for an extension's start
     * and for rows written before the level was recorded. The record of the
     * start, not the chat's mode now: the chat's own mode can change later, and
     * lowering the starter later changes nothing here.
     */
    permissionMode: text('permission_mode'),
    /**
     * The starting chat's live mode at the moment of the start — the ceiling the
     * grant was checked against. NULL with no starting chat, for an extension's
     * start, and for rows written before the level was recorded.
     */
    starterPermissionMode: text('starter_permission_mode'),
    /**
     * Whether the grant sat at the starting chat's level exactly, as the two
     * runtimes' declared levels compare — not as their ids do: `acceptEdits`
     * and `auto` are one level, and Claude's and Codex's `default` are not.
     * Decided when the start is checked, because that is the one moment both
     * runtimes' declarations are in hand. NULL where the levels are.
     */
    permissionSameAsStarter: integer('permission_same_as_starter', { mode: 'boolean' }),
    /**
     * Whether a `kind = 'chat'` start reports back to the chat that started it
     * when a turn ends finished, failed, needing the person or paused at a
     * limit (spec `spin-off-chats` §5). On unless `session_start` was told
     * `reportBack: 'off'`; an extension's start never reports to a chat.
     */
    reportBack: integer('report_back', { mode: 'boolean' }).notNull().default(true),
    /** When it was started (ISO 8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('session_started_by_origin_created_idx').on(table.originExtensionId, table.createdAt),
    check('session_started_by_kind', sql`${table.kind} IN ('extension', 'chat')`),
  ]
);

/** A row of {@link sessionStartedBy}. */
export type SessionStartedByRow = typeof sessionStartedBy.$inferSelect;
