import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Standing, agent-level consent for a connected account (connection-scoping
 * spec `specs/connection-scoping/` §Part 1). Row existence IS the consent —
 * there is no `attached: boolean` column, because a detach deletes the row
 * rather than flipping a flag: an agent-level attachment has no "explicitly
 * not attached" state to distinguish from "never attached," unlike the
 * session-level table below.
 *
 * Every session belonging to `agentId` inherits this account's tools on its
 * next hydration (`SessionConnectorService.hydrateSession`), UNLESS a
 * `session_connector_attachments` row for the same account overrides it —
 * see that table's doc comment for the no-merge ladder.
 */
export const agentConnectorAttachments = sqliteTable(
  'agent_connector_attachments',
  {
    /** The agent (mesh `agentId`) this attachment belongs to. */
    agentId: text('agent_id').notNull(),
    /** The connected account id (`ConnectedAccountId`). */
    accountId: text('account_id').notNull(),
    /** ISO 8601 timestamp the standing attachment was created. */
    attachedAt: text('attached_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.accountId] }),
    index('agent_connector_attachments_account_idx').on(table.accountId),
  ]
);

/**
 * Session-level connector-attachment OVERRIDE (connection-scoping spec
 * §Part 1). Unlike the agent-level table, a row here is a tombstone, not just
 * a presence flag: `state = 'attached'` exposes an account the agent has not
 * standingly attached (session-only grant); `state = 'detached'` SUPPRESSES
 * an account the agent HAS standingly attached, for this session only. Both
 * states must be persisted as explicit rows — "no session-level record for
 * this account" is a third, different state (inherit the agent's standing
 * attachment), and a plain delete-on-detach could not distinguish "never
 * touched" from "explicitly turned off."
 *
 * Precedence: session > agent, no merge. See
 * `specs/connection-scoping/design-decisions.md` D2.
 */
export const sessionConnectorAttachments = sqliteTable(
  'session_connector_attachments',
  {
    /** The session this override belongs to. */
    sessionId: text('session_id').notNull(),
    /** The connected account id (`ConnectedAccountId`). */
    accountId: text('account_id').notNull(),
    /** `'attached' | 'detached'` — the override direction. */
    state: text('state', { enum: ['attached', 'detached'] }).notNull(),
    /** ISO 8601 timestamp of the most recent attach/detach call. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.accountId] }),
    index('session_connector_attachments_account_idx').on(table.accountId),
  ]
);

/**
 * A chat an adapter received a message from that no binding connects to an
 * agent (connection-scoping spec §Part 3) — the durable form of what used to
 * be a silent `BindingRouter` drop. Deliberately carries NO message-body
 * column: only subject-derived routing fields (`adapterId`/`chatId`/
 * `channelType`) and sender-identity metadata parsed the same narrow way
 * `binding-router.ts`'s `extractPlatformUserId` already does — never the
 * envelope payload's text. See `specs/connection-scoping/design-decisions.md`
 * D6.
 *
 * `(adapter_id, chat_id)` is unique: a chat has at most one unclaimed-chat
 * row for its whole lifetime, damped by `messageCount`/`lastSeenAt` rather
 * than one row per inbound message (a spammy stranger chat records once).
 */
export const unclaimedChats = sqliteTable(
  'unclaimed_chats',
  {
    id: text('id').primaryKey(),
    adapterId: text('adapter_id').notNull(),
    chatId: text('chat_id').notNull(),
    /** `ChannelTypeSchema` value read off the relay subject, or null. */
    channelType: text('channel_type'),
    /** `'dm' | 'group'` — derived from the relay subject's channel segment, not the payload. */
    chatKind: text('chat_kind', { enum: ['dm', 'group'] }).notNull(),
    /** Display name only — never a raw platform identity blob. */
    senderName: text('sender_name'),
    /** Platform user id of the first sender seen, when the payload carries one. */
    senderId: text('sender_id'),
    /**
     * Group/channel display title (Telegram `chat.title`, Slack channel
     * name), when the adapter's own payload already carries one — the same
     * top-level `payload.channelName` field `senderName` is read from, never
     * an extra platform lookup. Null for a DM (no title exists) or when the
     * adapter didn't resolve one for this sighting. The claim card needs a
     * human-readable label for "added to a group" (plan §8); this is that
     * label.
     */
    chatTitle: text('chat_title'),
    status: text('status', {
      enum: ['pending', 'claimed', 'ignored', 'blocked'],
    })
      .notNull()
      .default('pending'),
    /** Damping counter — bumped, not re-inserted, on repeat sightings. */
    messageCount: integer('message_count').notNull().default(1),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    /** Set on claim/ignore/block. Null while `status = 'pending'`. */
    decidedAt: text('decided_at'),
    /** The agent the chat was claimed onto. Set only on `status = 'claimed'`. */
    decidedAgentId: text('decided_agent_id'),
  },
  (table) => [
    uniqueIndex('unclaimed_chats_adapter_chat_unique').on(table.adapterId, table.chatId),
    index('unclaimed_chats_status_idx').on(table.status),
  ]
);
