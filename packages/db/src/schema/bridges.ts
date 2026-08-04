import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * A room's durable identity as a bridged platform chat (chats-as-channels
 * spec §3.1).
 *
 * **This row, not the roster, is what a bridged room *is*.** `room_id` is the
 * primary key because a bridge and its room are 1:1 for the row's whole life —
 * there is no separate `id`, and every accessor that names a "bridge id" means
 * this column. `(adapter_id, chat_id)` is the second identity: it is what a
 * re-bridge resolves through (spec §3.5), never the roster's member set, which
 * is why `RoomStore.findDmByMemberSet` must exclude every room this table
 * names (spec §3.2) — a bridged private chat's roster is byte-identical to the
 * operator's own DM with the same agent, and matching on membership would
 * silently hand a stranger's chat log to that DM.
 *
 * **Archival never deletes this row or its refs** (spec §3.5). Un-bridging sets
 * `archived_at` and clears `binding.roomId`; re-bridging the same
 * `(adapter_id, chat_id)` finds the row again, clears `archived_at`, and keeps
 * `last_delivered_seq` and every `room_bridge_messages` ref intact — that
 * continuity is what keeps echo suppression and reply targeting working across
 * an unbridge/re-bridge cycle, including a re-bridge to a different agent
 * (§3.5's row-adoption case, which only rewrites `binding_id`).
 */
export const roomBridges = sqliteTable(
  'room_bridges',
  {
    /**
     * The bridged room. Primary key: one room has at most one bridge row, and
     * this row's identity IS the room's — there is no separate surrogate id.
     */
    roomId: text('room_id').primaryKey(),

    /** The relay adapter instance this chat lives on. */
    adapterId: text('adapter_id').notNull(),

    /** The platform chat id, scoped to `adapterId`. */
    chatId: text('chat_id').notNull(),

    /** `ChannelTypeSchema` value read off the relay subject, or null for a DM subject. */
    channelType: text('channel_type'),

    /** `'private' | 'group' | 'supergroup'` — read from `platformData.chatType`, never re-derived. */
    platformChatType: text('platform_chat_type').notNull(),

    /**
     * The platform chat's title, sanitized, as recorded when this room was
     * bridged (chats-as-channels spec §3.4). A room's own `title` can be
     * renamed afterward without touching this column (`room-service.ts`'s
     * rename path never writes here) — that gap is exactly what lets the room
     * sheet show the platform's own title as a subtitle next to a room name
     * that may have since diverged from it. `null` for a bridged DM, whose
     * title is the person's display name rather than a platform-side chat
     * title.
     */
    platformTitle: text('platform_title'),

    /**
     * The binding currently pointing at this bridge. Re-pointed, never
     * duplicated, when a different agent adopts the surviving row (spec §3.5).
     */
    bindingId: text('binding_id').notNull(),

    /** `'mentions-only' | 'everything' | null` — spec §8's privacy-mode badge. */
    visibility: text('visibility'),

    /** When `visibility` was last confirmed against the platform. */
    visibilityCheckedAt: text('visibility_checked_at'),

    /**
     * Whether `turn_failed` / `halted` notices reach this chat (spec §6.2, D-6
     * Q5). Seeded by room kind at creation — true for a bridged `dm`, false for
     * a bridged `channel` — with this column as the one per-bridge override.
     */
    deliverNotices: integer('deliver_notices', { mode: 'boolean' }).notNull(),

    /**
     * The catch-up scan's cursor (spec §6.1): entries at or below this `seq`
     * have already been considered for delivery. The scan, not the live
     * stream, is delivery's authority — this is what lets it resume after a
     * disconnect instead of re-walking the whole room.
     */
    lastDeliveredSeq: integer('last_delivered_seq').notNull().default(0),

    /** Last time an entry was ingested or delivered through this bridge (spec §7.5). */
    lastActivityAt: text('last_activity_at'),

    createdAt: text('created_at').notNull(),

    /** Set on unbridge/terminal failure (spec §3.5, §10.3, §10.9). Null while live. */
    archivedAt: text('archived_at'),
  },
  (table) => [
    // One room cannot serve two bridges, and one platform chat cannot back
    // two rooms — spec §10.10's two failure modes, both refused at write
    // rather than by a guard clause a future caller could skip.
    uniqueIndex('room_bridges_adapter_chat_unique').on(table.adapterId, table.chatId),
  ]
);

/**
 * The bridge's external-ref table — the ONLY echo-suppression mechanism in the
 * chats-as-channels feature (spec §6.3). No text comparison, no time window,
 * no recently-sent cache: an entry with an `inbound` ref was heard from the
 * platform and is never sent back to it; an entry with an `outbound` ref was
 * already delivered (or is being delivered right now) and a retry is a no-op.
 *
 * **`platform_message_id` is nullable because of write-before-send** (spec
 * §6.3). `deliver` writes its `outbound` row BEFORE calling the platform, with
 * a null id, and patches the id in once the send returns — so a crash between
 * write and send leaves a row that *looks* delivered (a suppressed retry) and
 * never a duplicate a stranger sees twice. That asymmetry is why the dedup
 * index below is scoped to `direction = 'inbound'`: an outbound row's id is
 * transiently null by design and must never collide with the inbound lookup.
 *
 * **`thread_id` / `thread_name` carry a forum topic** (spec §5.6, §9.2). The id
 * targets outbound delivery at the right topic; the name is sanitized at write
 * time and rendered as a label outside the untrusted-content fence — it is
 * never re-derived from a live subject, because a folded room with no topic
 * label is an unreadable interleaving of several conversations.
 */
export const roomBridgeMessages = sqliteTable(
  'room_bridge_messages',
  {
    roomId: text('room_id').notNull(),

    /** The `room_entries.id` this ref is about. */
    entryId: text('entry_id').notNull(),

    /** `'inbound' | 'outbound'`. */
    direction: text('direction').notNull(),

    /** The platform chat id, denormalized off the bridge row for a ref-only lookup. */
    chatId: text('chat_id').notNull(),

    /** The adapter instance, denormalized off the bridge row for a ref-only lookup. */
    adapterId: text('adapter_id').notNull(),

    /**
     * The platform's own message id. Null on a freshly written `outbound` row
     * (write-before-send, above); always present on an `inbound` row, whose
     * dedup index depends on it.
     */
    platformMessageId: text('platform_message_id'),

    /** Forum topic id, when the message carried `message_thread_id` (spec §5.6). */
    threadId: text('thread_id'),

    /** Sanitized forum topic name, recorded at write time (spec §5.6, §9.2). */
    threadName: text('thread_name'),

    createdAt: text('created_at').notNull(),
  },
  (table) => [
    // Inbound dedup lookup (spec §5.2 step 1): the same platform message
    // redelivered — webhook retry, or a polling/webhook overlap during
    // restart — must produce one entry, not two. Partial and scoped to
    // `direction = 'inbound'` because an outbound row's `platform_message_id`
    // is legitimately null (and later non-unique-by-construction) during the
    // write-before-send window.
    uniqueIndex('room_bridge_messages_inbound_dedup_unique')
      .on(table.adapterId, table.chatId, table.platformMessageId)
      .where(sql`"direction" = 'inbound'`),
    // Deliver idempotence (spec §6.3): one ref per entry, whichever direction
    // wrote it, so a delivery retry finds its own row and no-ops instead of
    // sending twice.
    uniqueIndex('room_bridge_messages_entry_unique').on(table.entryId),
    index('idx_room_bridge_messages_room_direction').on(table.roomId, table.direction),
  ]
);
