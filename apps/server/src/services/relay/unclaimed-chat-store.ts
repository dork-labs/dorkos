/**
 * Durable "unclaimed chat" store (connection-scoping spec
 * `specs/connection-scoping/` §Part 3) — the claim feed for inbound messages
 * with no binding, replacing what used to be a silent `BindingRouter` drop.
 *
 * **No message body ever reaches this store.** Every write here is fed only
 * subject-derived routing fields (`adapterId`/`chatId`/`channelType`) and a
 * narrow sender-identity parse of `platformData` — never `envelope.payload`'s
 * text. See `specs/connection-scoping/design-decisions.md` D6; the
 * corresponding test (`AC3.3`) greps the persisted row and the broadcast
 * payload for a sentinel planted in a fake message body, not just the type.
 *
 * Damping: a chat's row is written ONCE (`recordSighting`'s first call);
 * every subsequent inbound from the same still-pending chat bumps
 * `messageCount`/`lastSeenAt` in place. `status = 'blocked'` short-circuits
 * BEFORE any write — genuinely recordless, per spec.
 *
 * @module services/relay/unclaimed-chat-store
 */
import { randomUUID } from 'node:crypto';
import { unclaimedChats, eq, and, asc, count, type Db } from '@dorkos/db';
import type { PlatformChatType } from '@dorkos/shared/relay-schemas';
import { logger } from '../../lib/logger.js';

/** Lifecycle status of one unclaimed-chat row. */
export type UnclaimedChatStatus = 'pending' | 'claimed' | 'ignored' | 'blocked';

/**
 * `'dm' | 'group'` — derived from the relay SUBJECT's channel segment
 * (`BindingRouter.recordUnclaimedChat`: `channelType === 'group' ? 'group' :
 * 'dm'`, the same `parseHumanSubject` output binding resolution scores
 * against), never read from the payload's `platformData.chatType`. Kept
 * consistent with how the rest of routing already treats "what kind of chat
 * is this" — the subject is the one place that classification is decided.
 */
export type UnclaimedChatKind = 'dm' | 'group';

/** One unclaimed-chat row, as persisted. */
export interface UnclaimedChat {
  id: string;
  adapterId: string;
  chatId: string;
  channelType: string | null;
  chatKind: UnclaimedChatKind;
  /**
   * The RAW platform chat type (`platformData.chatType`), when the adapter
   * reported one — kept distinct from {@link chatKind} so a broadcast `channel`
   * is not folded into `group`. Null for an adapter that reports none (Slack)
   * or a row written before this column existed (DOR-907).
   */
  platformChatType: PlatformChatType | null;
  senderName: string | null;
  senderId: string | null;
  /** Group/channel display title, when the adapter's payload already carried one. Null for a DM. */
  chatTitle: string | null;
  status: UnclaimedChatStatus;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  decidedAt: string | null;
  decidedAgentId: string | null;
}

/**
 * Longest `senderName`/`chatTitle` this store will persist. Both are
 * stranger-controlled (a Telegram/Slack display name or group title, set by
 * whoever is on the other end) — the repo already treats stranger-controlled
 * display strings as worth bounding elsewhere, and an unbounded string
 * flowing untouched from an inbound payload into a durable row is exactly
 * the kind of thing that invariant exists for. Truncated, not rejected: a
 * claim card showing a clipped name is still useful; refusing to record the
 * sighting at all is not the safer choice here.
 */
const MAX_DISPLAY_NAME_LENGTH = 200;

/** Truncate a stranger-controlled display string to {@link MAX_DISPLAY_NAME_LENGTH}. */
function truncateDisplayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_DISPLAY_NAME_LENGTH ? value.slice(0, MAX_DISPLAY_NAME_LENGTH) : value;
}

/** Metadata one inbound sighting carries — deliberately NOT the message body. */
export interface UnclaimedChatSighting {
  adapterId: string;
  chatId: string;
  channelType?: string | undefined;
  chatKind: UnclaimedChatKind;
  /** The raw platform chat type (`platformData.chatType`), when the adapter reported one. */
  platformChatType?: PlatformChatType | undefined;
  senderName?: string | undefined;
  senderId?: string | undefined;
  /** Group/channel display title, when the adapter's own payload carried one. */
  chatTitle?: string | undefined;
}

/** The result of {@link UnclaimedChatStore.recordSighting}. */
export interface RecordSightingResult {
  /** The current row after recording this sighting. */
  chat: UnclaimedChat;
  /** `true` when this sighting created the row (fire the claim-feed event). */
  isFirstSighting: boolean;
}

/**
 * Ceiling on `pending` rows this store keeps at once. A publicly-discoverable
 * bot (spec §8) means the claim feed is reachable by anyone who can message
 * it — without a cap, a burst of throwaway chats grows this table without
 * bound. When a NEW pending chat would push the count over the cap, the
 * OLDEST pending chat (by `firstSeenAt`) is evicted first — a card nobody
 * looked at in a flood is the one to lose, not the newest arrival.
 */
const MAX_PENDING_CHATS = 200;

/** Durable store for chats an adapter heard from with no binding to route to. */
export class UnclaimedChatStore {
  private readonly _db: Db;

  constructor(db: Db) {
    this._db = db;
  }

  /**
   * Record one inbound sighting of an unbound chat. Damped: a `pending` or
   * `ignored` chat already on file has its counters bumped, in place, and
   * `isFirstSighting: false` — no new row, no repeat notification. A
   * `blocked` chat must never reach this method; see
   * {@link UnclaimedChatStore.isBlocked}, checked by the caller first.
   *
   * A brand-new row is capped at {@link MAX_PENDING_CHATS} pending chats —
   * see {@link evictOldestPendingIfOverCap}.
   *
   * @param sighting - Subject-derived routing fields + sender identity — never a message body.
   */
  recordSighting(sighting: UnclaimedChatSighting): RecordSightingResult {
    const now = new Date().toISOString();
    const existing = this._db
      .select()
      .from(unclaimedChats)
      .where(
        and(
          eq(unclaimedChats.adapterId, sighting.adapterId),
          eq(unclaimedChats.chatId, sighting.chatId)
        )
      )
      .get();

    if (existing) {
      const updated: UnclaimedChat = {
        ...toDomain(existing),
        messageCount: existing.messageCount + 1,
        lastSeenAt: now,
      };
      this._db
        .update(unclaimedChats)
        .set({ messageCount: updated.messageCount, lastSeenAt: now })
        .where(eq(unclaimedChats.id, existing.id))
        .run();
      return { chat: updated, isFirstSighting: false };
    }

    const row = {
      id: randomUUID(),
      adapterId: sighting.adapterId,
      chatId: sighting.chatId,
      channelType: sighting.channelType ?? null,
      chatKind: sighting.chatKind,
      platformChatType: sighting.platformChatType ?? null,
      senderName: truncateDisplayName(sighting.senderName) ?? null,
      senderId: sighting.senderId ?? null,
      chatTitle: truncateDisplayName(sighting.chatTitle) ?? null,
      status: 'pending' as const,
      messageCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      decidedAt: null,
      decidedAgentId: null,
    };
    this._db.insert(unclaimedChats).values(row).run();
    this.evictOldestPendingIfOverCap();
    return { chat: row, isFirstSighting: true };
  }

  /**
   * When the `pending` count exceeds {@link MAX_PENDING_CHATS}, delete the
   * oldest pending row(s) (by `firstSeenAt`) until back at the cap. A single
   * `recordSighting` call inserts at most one new row, so this evicts at
   * most one row per call — the log line is naturally damped by that, not by
   * a separate rate limiter.
   */
  private evictOldestPendingIfOverCap(): void {
    const [row] = this._db
      .select({ n: count() })
      .from(unclaimedChats)
      .where(eq(unclaimedChats.status, 'pending'))
      .all();
    const total = row?.n ?? 0;
    const overflow = total - MAX_PENDING_CHATS;
    if (overflow <= 0) return;

    const toEvict = this._db
      .select({
        id: unclaimedChats.id,
        adapterId: unclaimedChats.adapterId,
        chatId: unclaimedChats.chatId,
      })
      .from(unclaimedChats)
      .where(eq(unclaimedChats.status, 'pending'))
      .orderBy(asc(unclaimedChats.firstSeenAt))
      .limit(overflow)
      .all();
    for (const evicted of toEvict) {
      this._db.delete(unclaimedChats).where(eq(unclaimedChats.id, evicted.id)).run();
    }
    logger.warn(
      `[UnclaimedChats] pending cap (${MAX_PENDING_CHATS}) exceeded; evicted ${toEvict.length} oldest pending chat(s)`,
      { evicted: toEvict.map((e) => ({ adapterId: e.adapterId, chatId: e.chatId })) }
    );
  }

  /**
   * Whether `(adapterId, chatId)` is blocked — checked by the router BEFORE
   * calling `recordSighting`, so a blocked chat's future traffic never
   * touches this store again (spec: "block drops future traffic
   * recordless").
   */
  isBlocked(adapterId: string, chatId: string): boolean {
    const row = this._db
      .select({ status: unclaimedChats.status })
      .from(unclaimedChats)
      .where(and(eq(unclaimedChats.adapterId, adapterId), eq(unclaimedChats.chatId, chatId)))
      .get();
    return row?.status === 'blocked';
  }

  /** List unclaimed chats, optionally filtered by status (default `'pending'`). */
  list(status: UnclaimedChatStatus = 'pending'): UnclaimedChat[] {
    return this._db
      .select()
      .from(unclaimedChats)
      .where(eq(unclaimedChats.status, status))
      .all()
      .map(toDomain);
  }

  /** Look up one unclaimed chat by its row id. */
  getById(id: string): UnclaimedChat | undefined {
    const row = this._db.select().from(unclaimedChats).where(eq(unclaimedChats.id, id)).get();
    return row ? toDomain(row) : undefined;
  }

  /** Mark a chat claimed onto `agentId`. Caller creates the binding first. */
  claim(id: string, agentId: string): void {
    this._db
      .update(unclaimedChats)
      .set({ status: 'claimed', decidedAt: new Date().toISOString(), decidedAgentId: agentId })
      .where(eq(unclaimedChats.id, id))
      .run();
  }

  /** Mute a chat — future sightings still bump counters, silently, never resurfacing. Idempotent. */
  ignore(id: string): void {
    this._db
      .update(unclaimedChats)
      .set({ status: 'ignored', decidedAt: new Date().toISOString() })
      .where(eq(unclaimedChats.id, id))
      .run();
  }

  /** Block a chat — future traffic is dropped recordless from this point on. Idempotent. */
  block(id: string): void {
    this._db
      .update(unclaimedChats)
      .set({ status: 'blocked', decidedAt: new Date().toISOString() })
      .where(eq(unclaimedChats.id, id))
      .run();
  }
}

/** Narrow a drizzle row (whose `status`/`chatKind` are widened to `string`) back to the domain shape. */
function toDomain(row: {
  id: string;
  adapterId: string;
  chatId: string;
  channelType: string | null;
  chatKind: string;
  platformChatType: string | null;
  senderName: string | null;
  senderId: string | null;
  chatTitle: string | null;
  status: string;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  decidedAt: string | null;
  decidedAgentId: string | null;
}): UnclaimedChat {
  return {
    ...row,
    chatKind: row.chatKind as UnclaimedChatKind,
    platformChatType: row.platformChatType as PlatformChatType | null,
    status: row.status as UnclaimedChatStatus,
  };
}
