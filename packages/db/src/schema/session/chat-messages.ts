import { sql } from 'drizzle-orm';
import { check, index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One message a chat sent another chat (spec `spin-off-chats` §2, ADR
 * 261009-171114): `chat_send`, a `session_start` first message, a spin-off's
 * report, or a stop.
 *
 * It is the server's record of WHO sent a message, and the only thing the app
 * draws a sender from. The receiving agent reads the words inside a nonce
 * fence; the app shows "From <agent> · <chat>" on a message only where a
 * fenced block's nonce matches a row here for that receiving chat, so a fence
 * somebody typed by hand stays plain text.
 *
 * Kept for as long as the chats: a row is what renders the Sent card in the
 * sending chat and the sender on the received message.
 */
export const chatMessages = sqliteTable(
  'chat_messages',
  {
    /** The receipt id the sender was handed. */
    id: text('id').primaryKey(),
    /** The receiving chat's canonical id. */
    toSessionId: text('to_session_id').notNull(),
    /** The sending chat's canonical id. */
    fromSessionId: text('from_session_id').notNull(),
    /** The sending agent's home, as Mesh registered it. */
    fromAgentPath: text('from_agent_path').notNull(),
    /** The sending agent's Mesh id, or NULL when Mesh did not know it. */
    fromAgentId: text('from_agent_id'),
    /** The sending agent's name when it sent, for a reader that has no Mesh. */
    fromAgentName: text('from_agent_name').notNull(),
    /** The sending chat's title when it sent, or NULL when it had none. */
    fromChatTitle: text('from_chat_title'),
    /** What it is. */
    kind: text('kind', { enum: ['message', 'report', 'start', 'stop'] }).notNull(),
    /** The words, as the sender wrote them (markdown). Empty for a stop with no reason. */
    text: text('text').notNull(),
    /** The Sent card's one-line label, as the sender wrote it, or NULL. */
    summary: text('summary'),
    /** The fence nonce the receiving agent read it under. NULL for a stop. */
    nonce: text('nonce'),
    /** The delivery the sender asked for. */
    delivery: text('delivery', { enum: ['queue', 'steer', 'interrupt'] }).notNull(),
    /**
     * Where it is now: waiting, joined a running turn, delivered after a stop,
     * running, answered, or never delivered.
     */
    status: text('status', {
      enum: ['queued', 'delivered', 'steered', 'interrupted', 'working', 'replied', 'failed'],
    }).notNull(),
    /** Why it failed, in plain words, or NULL. */
    failureReason: text('failure_reason'),
    /** The dispatcher's message id: the queue row the words wait in. */
    queueMessageId: text('queue_message_id'),
    /**
     * The loosest level the turn it starts may run at, JSON
     * (`TurnPermissionBound`): the sending chat's latest turn when it sent, or
     * `"runtime-default"` when that was not known.
     */
    ceilingJson: text('ceiling_json').notNull(),
    /** The chat message this one answers, or NULL. */
    replyToId: text('reply_to_id'),
    /** When it was sent (ISO 8601). */
    createdAt: text('created_at').notNull(),
    /** When its status last changed (ISO 8601). */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('chat_messages_to_idx').on(table.toSessionId, table.createdAt),
    index('chat_messages_from_idx').on(table.fromSessionId, table.createdAt),
    index('chat_messages_queue_idx').on(table.queueMessageId),
    check('chat_messages_kind', sql`${table.kind} IN ('message', 'report', 'start', 'stop')`),
  ]
);

/** A row of {@link chatMessages}. */
export type ChatMessageRow = typeof chatMessages.$inferSelect;

/**
 * The DM chat one agent keeps with another (spec `spin-off-chats` §1): where
 * `chat_send({ to: <agent id> })` lands. Opened on the first message, in the
 * receiving agent's home, and reused after.
 */
export const chatAgentDms = sqliteTable(
  'chat_agent_dms',
  {
    /** The sending agent's home. */
    fromAgentPath: text('from_agent_path').notNull(),
    /** The receiving agent's Mesh id. */
    toAgentId: text('to_agent_id').notNull(),
    /** The chat's canonical id. */
    sessionId: text('session_id').notNull(),
    /** When it was opened (ISO 8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.fromAgentPath, table.toAgentId] })]
);

/** A row of {@link chatAgentDms}. */
export type ChatAgentDmRow = typeof chatAgentDms.$inferSelect;

/**
 * How far one chat has read another through `chat_read` (spec `spin-off-chats`
 * §1): the default `since: 'last-read'` returns only what is newer.
 */
export const chatReadCursors = sqliteTable(
  'chat_read_cursors',
  {
    /** The reading chat's canonical id. */
    readerSessionId: text('reader_session_id').notNull(),
    /** The chat it read. */
    targetSessionId: text('target_session_id').notNull(),
    /** The id of the newest message it was given. */
    lastMessageId: text('last_message_id').notNull(),
    /** When it read (ISO 8601). */
    readAt: text('read_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.readerSessionId, table.targetSessionId] })]
);

/** A row of {@link chatReadCursors}. */
export type ChatReadCursorRow = typeof chatReadCursors.$inferSelect;
