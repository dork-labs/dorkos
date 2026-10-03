import { sql } from 'drizzle-orm';
import { check, index, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Where a message an extension sent with `ctx.agent.send` is in its life
 * (DOR-2683):
 *
 * - `held` — accepted, but not yet handed to the dispatcher because there was
 *   no room (the launch cap, or the extension's start limits for opening the
 *   agent's chat). `content` holds the words until it is sent.
 * - `queued` — handed to the dispatcher and waiting behind a running turn in
 *   `session_message_queue`, under the same id.
 * - `started` — a turn began with it.
 * - `done` — that turn ended.
 * - `failed` — it will never run; `failure_reason` says why.
 */
export const EXTENSION_AGENT_SEND_STATUSES = [
  'held',
  'queued',
  'started',
  'done',
  'failed',
] as const;

/** One status. See {@link EXTENSION_AGENT_SEND_STATUSES}. */
export type ExtensionAgentSendStatus = (typeof EXTENSION_AGENT_SEND_STATUSES)[number];

/**
 * Every message an extension sent an agent with `ctx.agent.send` (DOR-2683):
 * the receipt behind its idempotency key, the words it is holding while there
 * is no room, and how far it has got, so the extension can be told what became
 * of it even across a restart.
 *
 * Its own table because nothing existing answers these questions. A
 * `session_message_queue` row is deleted the moment its turn starts, holds no
 * key, and does not exist at all for a message held for capacity. `id` is the
 * message id the receipt carries, and the same id the dispatcher queues and
 * runs it under.
 *
 * A finished row (`done` or `failed`) is pruned 24 hours after it was sent; an
 * unfinished one is kept until it finishes.
 */
export const extensionAgentSends = sqliteTable(
  'extension_agent_sends',
  {
    /** The message id: on the receipt, the queue row and every delivery event. */
    id: text('id').primaryKey(),
    /** The extension that sent it. Part of the key, so one extension's keys never answer another's. */
    extensionId: text('extension_id').notNull(),
    /** The extension's own key for this send (1-200 characters). */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The Mesh agent it was for, when it was addressed to an agent rather than a chat. */
    agentId: text('agent_id'),
    /** The chat it went to (canonical id), or null while an agent's chat is not open yet. */
    sessionId: text('session_id'),
    /** The folder the chat runs in, as the dispatch resolved it; what a restart resumes it in. */
    cwd: text('cwd'),
    /** See {@link EXTENSION_AGENT_SEND_STATUSES}. */
    status: text('status', { enum: EXTENSION_AGENT_SEND_STATUSES }).notNull(),
    /** What the first send was told: running now, or waiting. */
    receiptStatus: text('receipt_status', { enum: ['started', 'queued'] }).notNull(),
    /** Why the first send was told it is waiting (`busy`, `at_capacity`); null when it started. */
    receiptReason: text('receipt_reason', { enum: ['busy', 'at_capacity'] }),
    /** Why it will never run, once `failed`; null otherwise. */
    failureReason: text('failure_reason'),
    /** The fenced message, kept only while `held`; null once it is dispatched. */
    content: text('content'),
    /** When it was sent (ISO 8601). The 24-hour key window is measured from here. */
    createdAt: text('created_at').notNull(),
    /** When its status last changed (ISO 8601). */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('extension_agent_sends_key_idx').on(table.extensionId, table.idempotencyKey),
    index('extension_agent_sends_status_idx').on(table.status),
    check(
      'extension_agent_sends_status',
      sql`${table.status} IN ('held', 'queued', 'started', 'done', 'failed')`
    ),
    check('extension_agent_sends_receipt', sql`${table.receiptStatus} IN ('started', 'queued')`),
  ]
);

/** A row of {@link extensionAgentSends}. */
export type ExtensionAgentSendRow = typeof extensionAgentSends.$inferSelect;

/**
 * The chat an extension keeps with one agent: where `ctx.agent.send` goes when
 * `to` is an agent id (DOR-2683).
 *
 * The first message an extension sends an agent opens a new chat in that
 * agent's home; every later one goes to the same chat, so messages to a busy
 * agent wait their turn in one place instead of each opening a chat beside the
 * person's own. A row whose chat no longer belongs to the agent (the agent
 * moved) is replaced by a new chat on the next send.
 */
export const extensionAgentChats = sqliteTable(
  'extension_agent_chats',
  {
    /** The extension. */
    extensionId: text('extension_id').notNull(),
    /** The Mesh agent id. */
    agentId: text('agent_id').notNull(),
    /** The kept chat (canonical id). */
    sessionId: text('session_id').notNull(),
    /** When the chat was opened (ISO 8601). */
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.extensionId, table.agentId] })]
);

/** A row of {@link extensionAgentChats}. */
export type ExtensionAgentChatRow = typeof extensionAgentChats.$inferSelect;
