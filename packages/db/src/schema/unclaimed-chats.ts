import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    /**
     * The RAW platform chat type this sighting arrived as (`platformData.
     * chatType`), when the adapter reported one — `private`/`group`/
     * `supergroup`/`channel` for Telegram. Unlike {@link chatKind}, which folds
     * a broadcast into `group`, this keeps `channel` distinct, so a binding
     * claimed from this row can carry the real type through to the bridge
     * action (DOR-907). Null for an adapter that reports no raw type (Slack) or
     * a sighting recorded before this column existed.
     */
    platformChatType: text('platform_chat_type', {
      enum: ['private', 'group', 'supergroup', 'channel'],
    }),
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
