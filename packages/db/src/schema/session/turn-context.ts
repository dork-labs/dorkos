import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * What one turn actually handed its runtime (spec "Agent context viewer +
 * session timeline", phase 1: Record). One row per hand-over, written at the
 * single point where a runtime adapter gives the prompt to its backend, never
 * rebuilt afterwards.
 *
 * The text itself lives in {@link turnContextBodies}, stored once per distinct
 * body and referenced from {@link turnContextParts}. Rows go with their session,
 * and the bodies no live row still needs go with them.
 *
 * Private to the person (Security, Nov 8): nothing reads this table except the
 * internal service that writes it. No route, no agent tool, no extension.
 */
export const turnContexts = sqliteTable(
  'turn_contexts',
  {
    /** A random id for this hand-over. */
    id: text('id').primaryKey(),
    /** The session that took the turn. Moved across a canonical-id rekey. */
    sessionId: text('session_id').notNull(),
    /** The server-minted id of the message the turn delivered, when there was one. */
    messageId: text('message_id'),
    /** Which runtime received it: `claude-code`, `codex`, `opencode`, `doe`, ... */
    runtime: text('runtime').notNull(),
    /** Where the turn happened: `chat`, `room`, `dm`, `task` or `heartbeat`. */
    place: text('place').notNull(),
    /** The permission mode the turn ran at, as the adapter resolved it, or NULL. */
    permissionMode: text('permission_mode'),
    /**
     * Whether the system part rode THIS hand-over. A runtime that sends it once
     * and keeps it says so here: Codex sends its stable half once per thread,
     * and a warm Claude Code process holds the append it was launched with, so
     * a later turn records the append it is running on with this set false.
     * OpenCode and Doe send theirs every turn.
     */
    systemSentThisTurn: integer('system_sent_this_turn', { mode: 'boolean' }).notNull(),
    /**
     * The runtime's own token count for the context, by category, as JSON, or
     * NULL when it reported none. Claude Code's is asked for at the turn's
     * start; never a reconstruction of text the runtime did not show.
     */
    usage: text('usage'),
    /** `measured` (the runtime counted it) or `estimate`; NULL with no usage. */
    usageKind: text('usage_kind'),
    /** When it was handed over (ISO 8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_turn_contexts_session').on(table.sessionId, table.createdAt)]
);

/**
 * The named pieces of one hand-over, in the order the runtime received them:
 * a Claude Code session append and the turn's prompt, a Codex prompt, an
 * OpenCode system body and its synthetic part, Doe's system channel.
 */
export const turnContextParts = sqliteTable(
  'turn_context_parts',
  {
    /** The hand-over this piece belongs to. */
    turnContextId: text('turn_context_id')
      .notNull()
      .references(() => turnContexts.id, { onDelete: 'cascade' }),
    /** Zero-based order within the hand-over. */
    position: integer('position').notNull(),
    /** What the piece is: `system_append`, `prompt`, `system`, `synthetic`, ... */
    slot: text('slot').notNull(),
    /** sha256 (hex) of the stored body. Kept after the body itself is gone. */
    bodyHash: text('body_hash').notNull(),
    /** Size of the stored body in UTF-8 bytes. */
    bytes: integer('bytes').notNull(),
    /** Estimated tokens (about four characters each); an estimate, not a count. */
    tokensEstimate: integer('tokens_estimate').notNull(),
    /** True when a secret was swept out before storing, so the body differs from what was sent. */
    redacted: integer('redacted', { mode: 'boolean' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.turnContextId, table.position] }),
    index('idx_turn_context_parts_hash').on(table.bodyHash),
  ]
);

/**
 * Each distinct body, once. A body lives only while a part younger than the
 * retention window still names it: deleting the last session that uses it, or
 * ageing past 30 days, deletes the text (Security, Nov 8).
 */
export const turnContextBodies = sqliteTable('turn_context_bodies', {
  /** sha256 (hex) of `body`. */
  hash: text('hash').primaryKey(),
  /** The text exactly as stored. */
  body: text('body').notNull(),
  /** When this body was first stored (ISO 8601). */
  createdAt: text('created_at').notNull(),
});

/** A row of {@link turnContexts}. */
export type TurnContextRow = typeof turnContexts.$inferSelect;
/** A row of {@link turnContextParts}. */
export type TurnContextPartRow = typeof turnContextParts.$inferSelect;
