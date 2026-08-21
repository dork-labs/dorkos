/**
 * Persistence for a room's bridge identity and the external-ref table that
 * suppresses echo between a bridged room and the platform chat it projects
 * (chats-as-channels spec §3.1, §6.3).
 *
 * Synchronous throughout (`better-sqlite3`), like every other store in this
 * domain (`apps/server/src/services/rooms/room-store.ts`). Every write that
 * task 1.6 needs alongside a room write — recording an inbound ref beside
 * `RoomStore.appendEntry`, for instance — takes an optional {@link DbTransaction}
 * so the caller can run both inside its own `db.transaction(...)` callback.
 * On this single-connection `better-sqlite3` database that participation is
 * already structural (see `DbTransaction`'s doc in `@dorkos/db` for why); the
 * parameter's job is to make it explicit and reviewable at the call site,
 * not to be the thing that makes the write atomic.
 *
 * This store owns exactly two tables and no conduct: it does not decide who
 * may bridge a chat, what counts as delivery-eligible, or when a notice gets
 * written. Those are `ingest`/`deliver`'s business (spec §5.2, §6.1) and
 * arrive in later tasks; this module is the schema-shaped floor they stand on.
 *
 * @module server/services/relay/chat-bridge/bridge-store
 */
import {
  roomBridges,
  roomBridgeMessages,
  roomEntries,
  and,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  type Db,
  type DbTransaction,
} from '@dorkos/db';

/**
 * `room_bridges.platform_chat_type` — read from `platformData.chatType`, never
 * re-derived (spec §3.3). The shared {@link PlatformChatType} MINUS `channel`:
 * a broadcast is refused before any bridge row is written, so a stored row can
 * only ever hold one of these three bridgeable types.
 */
export type BridgeablePlatformChatType = 'private' | 'group' | 'supergroup';

/** `room_bridges.visibility` — spec §8's privacy-mode badge. */
export type BridgeVisibility = 'mentions-only' | 'everything' | null;

/** `room_bridge_messages.direction`. */
export type RefDirection = 'inbound' | 'outbound';

/** A stored `room_bridges` row, narrowed onto its domain unions. */
export interface Bridge {
  roomId: string;
  adapterId: string;
  chatId: string;
  channelType: string | null;
  platformChatType: BridgeablePlatformChatType;
  bindingId: string;
  visibility: BridgeVisibility;
  visibilityCheckedAt: string | null;
  /**
   * The platform chat's sanitized title, as recorded when this room was
   * bridged (spec §3.4) — `null` for a bridged DM. Read by
   * {@link RoomService.withRoster} for the room sheet's subtitle; never
   * updated by a room rename, which is the whole point of it.
   */
  platformTitle: string | null;
  deliverNotices: boolean;
  lastDeliveredSeq: number;
  lastActivityAt: string | null;
  createdAt: string;
  archivedAt: string | null;
}

/** What {@link BridgeStore.createBridge} needs. Every column, explicitly. */
export interface NewBridge {
  roomId: string;
  adapterId: string;
  chatId: string;
  channelType: string | null;
  platformChatType: BridgeablePlatformChatType;
  bindingId: string;
  /**
   * The platform chat's sanitized title at bridge time, or `null` for a
   * bridged DM (spec §3.4). The SAME sanitized value `RoomService.
   * createBridgedRoom` used to name the room — never a second sanitization.
   */
  platformTitle: string | null;
  /** Seeded by room kind at creation (D-6 Q5) — true for a bridged `dm`, false for a bridged `channel`. */
  deliverNotices: boolean;
  createdAt: string;
}

/** A stored `room_bridge_messages` row, narrowed onto its domain unions. */
export interface ExternalRef {
  roomId: string;
  entryId: string;
  direction: RefDirection;
  chatId: string;
  adapterId: string;
  platformMessageId: string | null;
  threadId: string | null;
  threadName: string | null;
  createdAt: string;
}

/** What {@link BridgeStore.recordInboundRef} needs — the platform id is required (spec §5.2 step 6). */
export interface NewInboundRef {
  roomId: string;
  entryId: string;
  chatId: string;
  adapterId: string;
  platformMessageId: string;
  threadId?: string | null;
  threadName?: string | null;
  createdAt: string;
}

/**
 * What {@link BridgeStore.recordOutboundRef} needs. No `platformMessageId` —
 * write-before-send means it is always null at write time (spec §6.3);
 * {@link BridgeStore.patchOutboundPlatformId} fills it in once the send returns.
 */
export interface NewOutboundRef {
  roomId: string;
  entryId: string;
  chatId: string;
  adapterId: string;
  threadId?: string | null;
  threadName?: string | null;
  createdAt: string;
}

/** Narrow a `room_bridges` row's stringly-typed columns onto the domain unions. */
function toBridge(row: typeof roomBridges.$inferSelect): Bridge {
  return {
    ...row,
    platformChatType: row.platformChatType as BridgeablePlatformChatType,
    visibility: row.visibility as BridgeVisibility,
  };
}

/** Narrow a `room_bridge_messages` row's stringly-typed `direction` onto the domain union. */
function toRef(row: typeof roomBridgeMessages.$inferSelect): ExternalRef {
  return { ...row, direction: row.direction as RefDirection };
}

/**
 * Either the store's own connection or a transaction handle a caller passed
 * in — what a read-back after a write must run against. Reading via
 * `this.db` unconditionally after a `tx`-scoped write would read the PRE-write
 * row when the write is still uncommitted inside the caller's transaction (or,
 * on a future non-single-connection `@dorkos/db`, could read a different
 * connection entirely); reading via the same `exec` the write used has no such
 * gap, on this connection or a later one.
 */
type Executor = Db | DbTransaction;

/** Persistence for `room_bridges` and `room_bridge_messages`. */
export class BridgeStore {
  constructor(private readonly db: Db) {}

  /**
   * The bridge for a room, read through whichever executor the caller is
   * scoped to — `this.db` for a public read, or a write's own `exec` for the
   * read-back right after that write (see {@link Executor}).
   */
  private readBridge(exec: Executor, roomId: string): Bridge | null {
    const row = exec.select().from(roomBridges).where(eq(roomBridges.roomId, roomId)).get();
    return row ? toBridge(row) : null;
  }

  /**
   * The ref for one entry, read through whichever executor the caller is
   * scoped to — see {@link BridgeStore.readBridge}.
   */
  private readRef(exec: Executor, entryId: string): ExternalRef | null {
    const row = exec
      .select()
      .from(roomBridgeMessages)
      .where(eq(roomBridgeMessages.entryId, entryId))
      .get();
    return row ? toRef(row) : null;
  }

  // === Bridge rows ===

  /**
   * Insert a bridge row.
   *
   * Constraint violations are NOT caught or translated here — a second row for
   * an occupied `roomId` or `(adapterId, chatId)` throws the raw `better-sqlite3`
   * unique-constraint error, which is the point (spec §10.10, A10.6): the
   * uniqueness is enforced by the index, not by a guard clause a future caller
   * could bypass by calling this method a different way.
   *
   * @param bridge - Every column of the new bridge row.
   * @param tx - An existing transaction to write inside, when this insert must
   *   be atomic with another table's write. Runs in its own transaction when
   *   omitted.
   */
  createBridge(bridge: NewBridge, tx?: DbTransaction): Bridge {
    const row = {
      ...bridge,
      visibility: null,
      visibilityCheckedAt: null,
      lastDeliveredSeq: 0,
      lastActivityAt: null,
      archivedAt: null,
    };
    const exec = tx ?? this.db;
    exec.insert(roomBridges).values(row).run();
    // Built from `row`, not re-read after the insert — `row` is already every
    // column the table has, so this is exactly what a read-back would return
    // and a round trip would buy nothing. Stays true only as long as `row`
    // above is kept COLUMN-COMPLETE: a schema change that adds a column with
    // a server-computed default (not one this literal sets) would silently
    // return a stale value here until this comment is remembered.
    return toBridge(row);
  }

  /**
   * The bridge for a platform chat — the identity re-bridging resolves through
   * (spec §3.5), never the roster's member set.
   *
   * @param adapterId - The adapter instance.
   * @param chatId - The platform chat id.
   */
  findBridgeByChat(adapterId: string, chatId: string): Bridge | null {
    const row = this.db
      .select()
      .from(roomBridges)
      .where(and(eq(roomBridges.adapterId, adapterId), eq(roomBridges.chatId, chatId)))
      .get();
    return row ? toBridge(row) : null;
  }

  /**
   * The bridge for a room, or `null` when the room is not bridged.
   *
   * @param roomId - The room.
   */
  findBridgeByRoom(roomId: string): Bridge | null {
    return this.readBridge(this.db, roomId);
  }

  /**
   * The bridges for a set of rooms, keyed by room id — one query for the whole
   * list, where {@link BridgeStore.findBridgeByRoom} is one per room.
   *
   * A room with no bridge is simply absent from the map, never a `null` value:
   * absent is what a `Map.get` already answers, and a second spelling of the
   * same fact is a second thing a caller could get wrong.
   *
   * `GET /api/rooms` is what needs it. The sidebar decides whether a direct
   * message is one a person made by hand or one a bridged chat projects
   * (`sidebar-simplification` D2), which it cannot do without knowing which
   * rooms are bridged — and asking per room turned a two-query list into one
   * query per room.
   *
   * @param roomIds - The rooms to ask about. An empty list asks nothing.
   */
  findBridgesByRooms(roomIds: readonly string[]): Map<string, Bridge> {
    if (roomIds.length === 0) return new Map();
    const rows = this.db
      .select()
      .from(roomBridges)
      .where(inArray(roomBridges.roomId, [...roomIds]))
      .all();
    return new Map(rows.map((row) => [row.roomId, toBridge(row)]));
  }

  /**
   * Every live (non-archived) bridge — the catch-up scan's worklist on start
   * (spec §6.1's first trigger). Archived bridges are excluded because a chat
   * that is no longer connected has nothing to catch up.
   */
  listLiveBridges(): Bridge[] {
    return this.db
      .select()
      .from(roomBridges)
      .where(isNull(roomBridges.archivedAt))
      .all()
      .map(toBridge);
  }

  /**
   * Every live bridge on one adapter — the catch-up scan's worklist when that
   * adapter reconnects (spec §6.1's reconnect trigger).
   *
   * @param adapterId - The adapter instance that just came back.
   */
  listLiveBridgesByAdapter(adapterId: string): Bridge[] {
    return this.db
      .select()
      .from(roomBridges)
      .where(and(eq(roomBridges.adapterId, adapterId), isNull(roomBridges.archivedAt)))
      .all()
      .map(toBridge);
  }

  /**
   * Stamp a bridge archived. The row and every ref survive (spec §3.5) — this
   * is the only column the method touches.
   *
   * @param roomId - The bridge, by its room id.
   * @param archivedAt - When it was archived, ISO 8601.
   * @param tx - An existing transaction to write inside.
   */
  archiveBridge(roomId: string, archivedAt: string, tx?: DbTransaction): Bridge | null {
    const exec = tx ?? this.db;
    exec.update(roomBridges).set({ archivedAt }).where(eq(roomBridges.roomId, roomId)).run();
    return this.readBridge(exec, roomId);
  }

  /**
   * Clear a bridge's `archivedAt` — the un-archive half of spec §3.5's
   * re-bridge-to-the-same-agent row reuse.
   *
   * @param roomId - The bridge, by its room id.
   * @param tx - An existing transaction to write inside.
   */
  unarchiveBridge(roomId: string, tx?: DbTransaction): Bridge | null {
    const exec = tx ?? this.db;
    exec.update(roomBridges).set({ archivedAt: null }).where(eq(roomBridges.roomId, roomId)).run();
    return this.readBridge(exec, roomId);
  }

  /**
   * Re-point a surviving bridge row at a different binding — spec §3.5's
   * different-agent re-bridge, which adopts the row rather than mints a second
   * one (the `UNIQUE (adapter_id, chat_id)` index makes a second one
   * impossible). This method only moves `bindingId`; swapping the roster's
   * bound agent and posting the notice are the caller's job.
   *
   * @param bridgeId - The bridge's room id (a bridge row has no id but its own).
   * @param bindingId - The binding that now owns this bridge.
   * @param tx - An existing transaction to write inside.
   */
  rebindBridge(bridgeId: string, bindingId: string, tx?: DbTransaction): Bridge | null {
    const exec = tx ?? this.db;
    exec.update(roomBridges).set({ bindingId }).where(eq(roomBridges.roomId, bridgeId)).run();
    return this.readBridge(exec, bridgeId);
  }

  /**
   * Advance `lastActivityAt` (spec §7.5).
   *
   * @param bridgeId - The bridge's room id.
   * @param at - The new activity timestamp, ISO 8601.
   * @param tx - An existing transaction to write inside.
   */
  stampActivity(bridgeId: string, at: string, tx?: DbTransaction): Bridge | null {
    const exec = tx ?? this.db;
    exec
      .update(roomBridges)
      .set({ lastActivityAt: at })
      .where(eq(roomBridges.roomId, bridgeId))
      .run();
    return this.readBridge(exec, bridgeId);
  }

  /**
   * Advance the catch-up scan's cursor (spec §6.1).
   *
   * Monotonic, like {@link RoomStore.setReadCursor}: a lower value is ignored,
   * so a delivery that resolves out of order — or a stale scan racing a faster
   * one — cannot move the cursor backward and make already-delivered entries
   * look undelivered again.
   *
   * @param bridgeId - The bridge's room id.
   * @param seq - The `seq` delivery has now reached.
   * @param tx - An existing transaction to write inside.
   */
  setLastDeliveredSeq(bridgeId: string, seq: number, tx?: DbTransaction): Bridge | null {
    const exec = tx ?? this.db;
    exec
      .update(roomBridges)
      .set({ lastDeliveredSeq: seq })
      .where(and(eq(roomBridges.roomId, bridgeId), lt(roomBridges.lastDeliveredSeq, seq)))
      .run();
    return this.readBridge(exec, bridgeId);
  }

  /**
   * Set the bridge's visibility badge (spec §8).
   *
   * @param bridgeId - The bridge's room id.
   * @param visibility - The new visibility, or `null` to clear it.
   * @param checkedAt - When it was confirmed against the platform, ISO 8601.
   * @param tx - An existing transaction to write inside.
   */
  setVisibility(
    bridgeId: string,
    visibility: BridgeVisibility,
    checkedAt: string,
    tx?: DbTransaction
  ): Bridge | null {
    const exec = tx ?? this.db;
    exec
      .update(roomBridges)
      .set({ visibility, visibilityCheckedAt: checkedAt })
      .where(eq(roomBridges.roomId, bridgeId))
      .run();
    return this.readBridge(exec, bridgeId);
  }

  /**
   * Flip the one per-bridge override for outbound notice delivery (D-6 Q5,
   * spec §6.2). `createBridge` seeds `deliverNotices` from room kind at
   * creation (`true` for a bridged `dm`, `false` for a bridged `channel`);
   * this is the only way to change it afterward — `RoomService.updateRoom`
   * is its one caller, gated on the room actually being bridged.
   *
   * @param bridgeId - The bridge's room id.
   * @param deliverNotices - The new value.
   * @param tx - An existing transaction to write inside.
   */
  setDeliverNotices(bridgeId: string, deliverNotices: boolean, tx?: DbTransaction): Bridge | null {
    const exec = tx ?? this.db;
    exec.update(roomBridges).set({ deliverNotices }).where(eq(roomBridges.roomId, bridgeId)).run();
    return this.readBridge(exec, bridgeId);
  }

  // === External refs ===

  /**
   * Record that an entry was created FROM this platform message (spec §5.2
   * step 6). Written in the same transaction as `RoomService.post`'s entry
   * write via the `tx` handle — steps 4–6 of §5.2 are one SQLite transaction.
   *
   * @param ref - The ref to write. `platformMessageId` is required — an
   *   inbound ref always names the message that produced it.
   * @param tx - An existing transaction to write inside.
   */
  recordInboundRef(ref: NewInboundRef, tx?: DbTransaction): ExternalRef {
    const row = {
      roomId: ref.roomId,
      entryId: ref.entryId,
      direction: 'inbound' as const,
      chatId: ref.chatId,
      adapterId: ref.adapterId,
      platformMessageId: ref.platformMessageId,
      threadId: ref.threadId ?? null,
      threadName: ref.threadName ?? null,
      createdAt: ref.createdAt,
    };
    const exec = tx ?? this.db;
    exec.insert(roomBridgeMessages).values(row).run();
    return toRef(row);
  }

  /**
   * Record that an entry is ABOUT to be delivered to this platform chat —
   * written BEFORE the platform call, with a null `platformMessageId` (spec
   * §6.3's write-before-send). {@link BridgeStore.patchOutboundPlatformId}
   * fills the id in once the send returns.
   *
   * @param ref - The ref to write.
   * @param tx - An existing transaction to write inside.
   */
  recordOutboundRef(ref: NewOutboundRef, tx?: DbTransaction): ExternalRef {
    const row = {
      roomId: ref.roomId,
      entryId: ref.entryId,
      direction: 'outbound' as const,
      chatId: ref.chatId,
      adapterId: ref.adapterId,
      platformMessageId: null,
      threadId: ref.threadId ?? null,
      threadName: ref.threadName ?? null,
      createdAt: ref.createdAt,
    };
    const exec = tx ?? this.db;
    exec.insert(roomBridgeMessages).values(row).run();
    return toRef(row);
  }

  /**
   * Fill in the platform message id an outbound ref was written without,
   * once the send that {@link BridgeStore.recordOutboundRef} preceded returns
   * (spec §6.3).
   *
   * @param entryId - The entry whose outbound ref this patches.
   * @param platformMessageId - The id the platform assigned the sent message.
   * @param tx - An existing transaction to write inside.
   */
  patchOutboundPlatformId(
    entryId: string,
    platformMessageId: string,
    tx?: DbTransaction
  ): ExternalRef | null {
    const exec = tx ?? this.db;
    exec
      .update(roomBridgeMessages)
      .set({ platformMessageId })
      .where(
        and(eq(roomBridgeMessages.entryId, entryId), eq(roomBridgeMessages.direction, 'outbound'))
      )
      .run();
    return this.readRef(exec, entryId);
  }

  /**
   * The ref for one entry, whichever direction wrote it — `deliver`'s
   * idempotence check (spec §6.3: "an existing outbound row is a no-op") and
   * the same predicate that makes echo suppression structural rather than
   * heuristic.
   *
   * @param entryId - The entry.
   */
  findRefByEntry(entryId: string): ExternalRef | null {
    return this.readRef(this.db, entryId);
  }

  /**
   * Remove an entry's OUTBOUND ref — the write-before-send rollback (spec §6.1,
   * §10.1).
   *
   * `deliver` writes its outbound ref BEFORE the platform call (spec §6.3), so a
   * send that DEFINITIVELY never reached the platform — the consent gate refused
   * it, or the adapter reported it undelivered after the retry budget — must not
   * leave the entry looking delivered forever. Removing the ref returns the entry
   * to `listUndeliveredAboveSeq`'s candidate set, which is what lets the catch-up
   * scan re-deliver it when the adapter comes back (spec §10.1's "the ref's null
   * platform id makes the entry eligible for the catch-up scan").
   *
   * **This is only ever called for a send `deliver` KNOWS did not land** — a
   * refusal or an exhausted retry, both observed by running code. A process that
   * crashed between the ref write and the send cannot reach here, so its null-id
   * ref survives and idempotence suppresses the retry (spec §6.3's fail-on-the-
   * suppressed-side): the row is scoped to `direction = 'outbound'` so it can
   * never touch the inbound dedup row.
   *
   * @param entryId - The entry whose outbound ref to remove.
   * @param tx - An existing transaction to write inside.
   */
  deleteOutboundRef(entryId: string, tx?: DbTransaction): void {
    const exec = tx ?? this.db;
    exec
      .delete(roomBridgeMessages)
      .where(
        and(eq(roomBridgeMessages.entryId, entryId), eq(roomBridgeMessages.direction, 'outbound'))
      )
      .run();
  }

  /**
   * The refs for a batch of entries, keyed by entry id — `room_context`'s
   * per-turn read of every pending and own-recent entry's forum-topic label
   * (chats-as-channels §5.6, §9.2), one query rather than one per entry.
   * Entries with no ref of either direction are simply absent from the map.
   *
   * @param entryIds - The entries to look up. An empty list short-circuits to
   *   an empty map without a query — the common case for an unbridged room's
   *   turn, and for a bridged room's turn before this batch is ever called.
   */
  findRefsByEntries(entryIds: readonly string[]): Map<string, ExternalRef> {
    if (entryIds.length === 0) return new Map();
    const rows = this.db
      .select()
      .from(roomBridgeMessages)
      .where(inArray(roomBridgeMessages.entryId, entryIds))
      .all();
    const map = new Map<string, ExternalRef>();
    for (const row of rows) map.set(row.entryId, toRef(row));
    return map;
  }

  /**
   * The inbound ref for a platform message, if one was already recorded — the
   * dedup lookup `ingest` runs first (spec §5.2 step 1). An existing row here
   * means the message has already produced an entry and `ingest` stops.
   *
   * @param adapterId - The adapter instance.
   * @param chatId - The platform chat id.
   * @param platformMessageId - The platform's own message id.
   */
  findInboundRefByPlatformMessage(
    adapterId: string,
    chatId: string,
    platformMessageId: string
  ): ExternalRef | null {
    const row = this.db
      .select()
      .from(roomBridgeMessages)
      .where(
        and(
          eq(roomBridgeMessages.adapterId, adapterId),
          eq(roomBridgeMessages.chatId, chatId),
          eq(roomBridgeMessages.platformMessageId, platformMessageId),
          eq(roomBridgeMessages.direction, 'inbound')
        )
      )
      .get();
    return row ? toRef(row) : null;
  }

  /**
   * Outbound refs whose platform id is STILL NULL and whose `createdAt` is
   * strictly before `olderThanIso` — the startup stranded-ref sweep's
   * candidate list (spec §10.1's crash divergence, DOR-898).
   *
   * `deliver`'s write-before-send (spec §6.3) writes this ref BEFORE the
   * platform call and patches the id in once the send returns; a KNOWN
   * failure (consent denied, retry budget exhausted) rolls it back via
   * {@link BridgeStore.deleteOutboundRef}. A ref that is still null-id past
   * the sweep's age threshold reached neither outcome — the process crashed
   * between the write and the send settling — and {@link listUndeliveredAboveSeq}
   * structurally EXCLUDES it (it has a ref, full stop), so nothing else in
   * this module will ever surface it again. This is the one query that does.
   *
   * Backed by `idx_room_bridge_messages_outbound_pending`, a partial index on
   * exactly this predicate (`direction = 'outbound' AND platform_message_id
   * IS NULL`), so the sweep costs a lookup over the (normally empty) pending
   * slice rather than a scan of every ref ever written.
   *
   * @param olderThanIso - Only refs created strictly before this ISO 8601
   *   timestamp qualify — the caller's `now - sweep threshold`, wide enough
   *   that a ref this age cannot still be a legitimate in-flight retry.
   */
  listStaleNullOutboundRefs(olderThanIso: string): ExternalRef[] {
    return this.db
      .select()
      .from(roomBridgeMessages)
      .where(
        and(
          eq(roomBridgeMessages.direction, 'outbound'),
          isNull(roomBridgeMessages.platformMessageId),
          lt(roomBridgeMessages.createdAt, olderThanIso)
        )
      )
      .all()
      .map(toRef);
  }

  /**
   * Entries above a `seq` that carry NO external ref of either direction, in
   * `seq` order — the catch-up scan's candidate list (spec §6.1).
   *
   * An entry with an `inbound` ref is excluded exactly because it has a ref at
   * all, which is what makes echo suppression fall out of this predicate
   * rather than needing a second one: the entry that arrived FROM the chat is
   * never a delivery candidate, and it already has a row here. An entry with an
   * `outbound` ref is excluded because it is already delivered (or being
   * delivered — write-before-send means the ref exists before the send
   * returns). What is left is genuinely undelivered.
   *
   * This is the candidate list, not the eligibility test: whether an
   * undelivered entry actually qualifies for delivery (`kind`, author, consent
   * — spec §6.1 criteria 2, 4, 5) is `deliver`'s job. It returns only each
   * candidate's `id` and `seq` — the light key the scan walks by — and the scan
   * hydrates the full entry through the room store's own reader rather than this
   * store re-parsing a `room_entries` row it does not own.
   *
   * @param roomId - The bridged room.
   * @param seq - Return entries with `seq` strictly above this.
   */
  listUndeliveredAboveSeq(roomId: string, seq: number): Array<{ id: string; seq: number }> {
    return this.db
      .select({ id: roomEntries.id, seq: roomEntries.seq })
      .from(roomEntries)
      .leftJoin(
        roomBridgeMessages,
        and(
          eq(roomBridgeMessages.roomId, roomEntries.roomId),
          eq(roomBridgeMessages.entryId, roomEntries.id)
        )
      )
      .where(
        and(
          eq(roomEntries.roomId, roomId),
          gt(roomEntries.seq, seq),
          isNull(roomBridgeMessages.entryId)
        )
      )
      .orderBy(roomEntries.seq)
      .all();
  }
}
