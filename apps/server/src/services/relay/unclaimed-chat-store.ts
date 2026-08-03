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
import { unclaimedChats, eq, and, type Db } from '@dorkos/db';

/** Lifecycle status of one unclaimed-chat row. */
export type UnclaimedChatStatus = 'pending' | 'claimed' | 'ignored' | 'blocked';

/** `'dm' | 'group'` — read from `platformData.chatType` when present, else `'dm'`. */
export type UnclaimedChatKind = 'dm' | 'group';

/** One unclaimed-chat row, as persisted. */
export interface UnclaimedChat {
  id: string;
  adapterId: string;
  chatId: string;
  channelType: string | null;
  chatKind: UnclaimedChatKind;
  senderName: string | null;
  senderId: string | null;
  status: UnclaimedChatStatus;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  decidedAt: string | null;
  decidedAgentId: string | null;
}

/** Metadata one inbound sighting carries — deliberately NOT the message body. */
export interface UnclaimedChatSighting {
  adapterId: string;
  chatId: string;
  channelType?: string | undefined;
  chatKind: UnclaimedChatKind;
  senderName?: string | undefined;
  senderId?: string | undefined;
}

/** The result of {@link UnclaimedChatStore.recordSighting}. */
export interface RecordSightingResult {
  /** The current row after recording this sighting. */
  chat: UnclaimedChat;
  /** `true` when this sighting created the row (fire the claim-feed event). */
  isFirstSighting: boolean;
}

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
      senderName: sighting.senderName ?? null,
      senderId: sighting.senderId ?? null,
      status: 'pending' as const,
      messageCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      decidedAt: null,
      decidedAgentId: null,
    };
    this._db.insert(unclaimedChats).values(row).run();
    return { chat: row, isFirstSighting: true };
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
  senderName: string | null;
  senderId: string | null;
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
    status: row.status as UnclaimedChatStatus,
  };
}
