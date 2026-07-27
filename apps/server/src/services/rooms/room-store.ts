/**
 * Drizzle CRUD over the five room tables.
 *
 * Synchronous throughout (`better-sqlite3`), so a post is one transaction with
 * no await inside it and the SSE handler can read the log and subscribe in the
 * same tick without opening a gap.
 *
 * This store owns exactly one non-obvious thing: `seq` allocation. Everything
 * else is a query; the row-to-domain mapping lives in `room-rows.ts`.
 *
 * @module server/services/rooms/room-store
 */
import {
  rooms,
  roomMembers,
  roomEntries,
  roomSessions,
  eq,
  and,
  inArray,
  lt,
  gt,
  sql,
  count,
  desc,
  type Db,
} from '@dorkos/db';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomEntry, RoomKind, RoomMember } from '@dorkos/shared/room-schemas';
import { toEntry, toMember, toRoom, type NewRoom, type NewRoomEntry } from './room-rows.js';

/** Persistence for rooms, memberships, entries, and per-room agent sessions. */
export class RoomStore {
  constructor(private readonly db: Db) {}

  // === Rooms ===

  /**
   * Insert a room and seed its roster in ONE transaction.
   *
   * Atomic on purpose. Seeding used to run as separate statements after the
   * room row was already committed, so a bad member id left a room that the
   * caller had just been told (404) was not created — holding its slug, showing
   * up in listings, and turning the obvious retry into a 409 SLUG_TAKEN for a
   * room they did not know they owned. Either the whole room exists with its
   * roster or none of it does.
   *
   * @param room - Every column of the new room.
   * @param members - The roster to seed, already resolved and validated.
   * @returns The inserted room.
   */
  createRoom(
    room: NewRoom,
    members: ReadonlyArray<{ authorId: string; responseMode: ResponseMode; joinedAt: string }>
  ): Room {
    const row = { ...room, archived: false, lastActivityAt: room.createdAt };
    this.db.transaction(
      (tx) => {
        tx.insert(rooms).values(row).run();
        for (const member of members) {
          tx.insert(roomMembers)
            .values({ ...member, roomId: room.id, lastReadSeq: 0 })
            .onConflictDoNothing()
            .run();
        }
      },
      { behavior: 'immediate' }
    );
    return toRoom(row);
  }

  /**
   * One room by id.
   *
   * @param id - The room id.
   */
  getRoom(id: string): Room | null {
    const row = this.db.select().from(rooms).where(eq(rooms.id, id)).get();
    return row ? toRoom(row) : null;
  }

  /**
   * Every room, newest activity first.
   *
   * Unscoped. The operator's own listing uses this — a single-player cockpit
   * that hid rooms from the person running it would be absurd. An AGENT's
   * listing must use {@link RoomStore.listRoomsForMember} instead.
   *
   * @param filter.kind - Restrict to one room kind.
   * @param filter.includeArchived - Include archived rooms (default false).
   */
  listRooms(filter: { kind?: RoomKind; includeArchived?: boolean } = {}): Room[] {
    const conditions = [];
    if (filter.kind) conditions.push(eq(rooms.kind, filter.kind));
    if (!filter.includeArchived) conditions.push(eq(rooms.archived, false));
    const rows = this.db
      .select()
      .from(rooms)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(rooms.lastActivityAt))
      .all();
    return rows.map(toRoom);
  }

  /**
   * The rooms one author belongs to, newest activity first.
   *
   * Scoped by an inner join on `room_members` rather than by filtering after
   * the read: a room an agent is not in must never be loaded, not loaded and
   * then hidden. This is the boundary that stops an agent enumerating the
   * operator's DMs with other agents.
   *
   * @param memberAuthorId - Whose rooms to list.
   * @param filter.kind - Restrict to one room kind.
   * @param filter.includeArchived - Include archived rooms (default false).
   */
  listRoomsForMember(
    memberAuthorId: string,
    filter: { kind?: RoomKind; includeArchived?: boolean } = {}
  ): Room[] {
    const conditions = [eq(roomMembers.authorId, memberAuthorId)];
    if (filter.kind) conditions.push(eq(rooms.kind, filter.kind));
    if (!filter.includeArchived) conditions.push(eq(rooms.archived, false));
    const rows = this.db
      .select({ room: rooms })
      .from(rooms)
      .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
      .where(and(...conditions))
      .orderBy(desc(rooms.lastActivityAt))
      .all();
    return rows.map((row) => toRoom(row.room));
  }

  /**
   * The live (non-archived) channel holding a slug, if any. Archiving a channel
   * releases its slug, which is what the partial unique index encodes.
   *
   * @param slug - The channel slug.
   */
  findLiveChannelBySlug(slug: string): Room | null {
    const row = this.db
      .select()
      .from(rooms)
      .where(and(eq(rooms.slug, slug), eq(rooms.kind, 'channel'), eq(rooms.archived, false)))
      .get();
    return row ? toRoom(row) : null;
  }

  /**
   * Patch a room's mutable fields.
   *
   * @param id - The room id.
   * @param patch - Fields to change; omitted fields are left alone.
   * @returns The updated room, or `null` when no such room exists.
   */
  updateRoom(
    id: string,
    patch: { title?: string; topic?: string | null; archived?: boolean }
  ): Room | null {
    if (Object.keys(patch).length > 0) {
      this.db.update(rooms).set(patch).where(eq(rooms.id, id)).run();
    }
    return this.getRoom(id);
  }

  // === Membership ===

  /**
   * Add a member, or leave an existing membership untouched.
   *
   * @param member - The membership to write.
   * @returns The stored membership.
   */
  addMember(member: {
    roomId: string;
    authorId: string;
    responseMode: ResponseMode;
    joinedAt: string;
  }): RoomMember {
    const row = { ...member, lastReadSeq: 0 };
    this.db.insert(roomMembers).values(row).onConflictDoNothing().run();
    return this.getMember(member.roomId, member.authorId) ?? toMember(row);
  }

  /**
   * One membership.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   */
  getMember(roomId: string, authorId: string): RoomMember | null {
    const row = this.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
      .get();
    return row ? toMember(row) : null;
  }

  /**
   * A room's roster, in join order.
   *
   * @param roomId - The room.
   */
  listMembers(roomId: string): RoomMember[] {
    const rows = this.db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId))
      .orderBy(roomMembers.joinedAt)
      .all();
    return rows.map(toMember);
  }

  /**
   * The memberships of several rooms in ONE query, in join order within each
   * room. The list endpoint resolves who is in every direct message it returns,
   * and doing that a room at a time would put an N+1 on the server to take one
   * off the client.
   *
   * @param roomIds - The rooms to read. An empty list reads nothing.
   */
  listMembersForRooms(roomIds: readonly string[]): RoomMember[] {
    if (roomIds.length === 0) return [];
    const rows = this.db
      .select()
      .from(roomMembers)
      .where(inArray(roomMembers.roomId, [...new Set(roomIds)]))
      .orderBy(roomMembers.roomId, roomMembers.joinedAt)
      .all();
    return rows.map(toMember);
  }

  /**
   * Every room an author belongs to.
   *
   * @param authorId - The member.
   */
  listMembershipsFor(authorId: string): RoomMember[] {
    const rows = this.db.select().from(roomMembers).where(eq(roomMembers.authorId, authorId)).all();
    return rows.map(toMember);
  }

  /**
   * Change a membership's response mode.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param responseMode - The new per-room override.
   * @returns The updated membership, or `null` when there is none.
   */
  setResponseMode(roomId: string, authorId: string, responseMode: ResponseMode): RoomMember | null {
    this.db
      .update(roomMembers)
      .set({ responseMode })
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
      .run();
    return this.getMember(roomId, authorId);
  }

  /**
   * Advance a member's read cursor. Monotonic: a lower value is ignored, so a
   * stale client cannot un-read a room for a second client.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param lastReadSeq - The seq the member has now read up to.
   * @returns The updated membership, or `null` when there is none.
   */
  setReadCursor(roomId: string, authorId: string, lastReadSeq: number): RoomMember | null {
    this.db
      .update(roomMembers)
      .set({ lastReadSeq })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.authorId, authorId),
          lt(roomMembers.lastReadSeq, lastReadSeq)
        )
      )
      .run();
    return this.getMember(roomId, authorId);
  }

  /**
   * Remove a member.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @returns Whether a membership was removed.
   */
  removeMember(roomId: string, authorId: string): boolean {
    const existed = this.getMember(roomId, authorId) !== null;
    this.db
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
      .run();
    this.db
      .delete(roomSessions)
      .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
      .run();
    return existed;
  }

  // === Entries ===

  /**
   * Append one entry, allocating its per-room `seq` inside the transaction.
   *
   * The transaction is **IMMEDIATE**, and that is the load-bearing detail. A
   * deferred transaction would take a read lock for the `MAX(seq)` select and
   * then have to upgrade it to write, which SQLite refuses with
   * `SQLITE_BUSY_SNAPSHOT` when another connection wrote in between — and does
   * not retry, `busy_timeout` or not. Taking the writer lock up front makes
   * `busy_timeout` do its job and makes "SQLite serialises writers" true, which
   * is what lets `COALESCE(MAX(seq),0)+1` stand in for a counter table.
   *
   * Also bumps the room's `lastActivityAt` in the same transaction, so a room
   * can never be listed as quiet while holding an entry nobody has seen.
   *
   * @param entry - The entry to write, minus `seq`.
   * @returns The stored entry, with its allocated `seq`.
   */
  appendEntry(entry: NewRoomEntry): RoomEntry {
    return this.db.transaction(
      (tx) => {
        const allocated = tx
          .select({ next: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0) + 1` })
          .from(roomEntries)
          .where(eq(roomEntries.roomId, entry.roomId))
          .get();
        const seq = allocated?.next ?? 1;

        tx.insert(roomEntries)
          .values({
            roomId: entry.roomId,
            seq,
            id: entry.id,
            authorId: entry.authorId,
            kind: entry.kind,
            body: JSON.stringify(entry.body),
            mentions: JSON.stringify(entry.mentions),
            sessionId: entry.sessionId,
            cascadeRoot: entry.cascadeRoot,
            cascadeDepth: entry.cascadeDepth,
            signature: null,
            createdAt: entry.createdAt,
          })
          .run();

        tx.update(rooms)
          .set({ lastActivityAt: entry.createdAt })
          .where(eq(rooms.id, entry.roomId))
          .run();

        return {
          roomId: entry.roomId,
          seq,
          id: entry.id,
          authorId: entry.authorId,
          kind: entry.kind,
          body: entry.body,
          mentions: [...entry.mentions],
          sessionId: entry.sessionId,
          cascadeRoot: entry.cascadeRoot,
          cascadeDepth: entry.cascadeDepth,
          signature: null,
          createdAt: entry.createdAt,
        };
      },
      { behavior: 'immediate' }
    );
  }

  /**
   * A page of history, oldest-first within the page.
   *
   * @param roomId - The room.
   * @param opts.before - Return entries with `seq` strictly below this.
   * @param opts.limit - Page size.
   */
  listEntries(roomId: string, opts: { before?: number; limit: number }): RoomEntry[] {
    const conditions = [eq(roomEntries.roomId, roomId)];
    if (opts.before !== undefined) conditions.push(lt(roomEntries.seq, opts.before));
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(and(...conditions))
      .orderBy(desc(roomEntries.seq))
      .limit(opts.limit)
      .all();
    return rows.reverse().map(toEntry);
  }

  /**
   * Every entry after a cursor, in `seq` order — the SSE replay read. The log
   * is never trimmed, so this can always be served gap-free.
   *
   * @param roomId - The room.
   * @param afterSeq - Return entries with `seq` strictly above this.
   */
  listEntriesAfter(roomId: string, afterSeq: number): RoomEntry[] {
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), gt(roomEntries.seq, afterSeq)))
      .orderBy(roomEntries.seq)
      .all();
    return rows.map(toEntry);
  }

  /**
   * One entry by its stable id.
   *
   * @param roomId - The room.
   * @param entryId - The entry id.
   */
  getEntryById(roomId: string, entryId: string): RoomEntry | null {
    const row = this.db
      .select()
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.id, entryId)))
      .get();
    return row ? toEntry(row) : null;
  }

  /**
   * The highest `seq` in a room, or 0 when it is empty.
   *
   * @param roomId - The room.
   */
  maxSeq(roomId: string): number {
    const row = this.db
      .select({ value: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0)` })
      .from(roomEntries)
      .where(eq(roomEntries.roomId, roomId))
      .get();
    return row?.value ?? 0;
  }

  /**
   * How many entries a member has not read.
   *
   * @param roomId - The room.
   * @param lastReadSeq - The member's read cursor.
   */
  countUnread(roomId: string, lastReadSeq: number): number {
    const row = this.db
      .select({ value: count() })
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), gt(roomEntries.seq, lastReadSeq)))
      .get();
    return row?.value ?? 0;
  }

  /**
   * The distinct authors already in one cascade — the ancestry rule's input.
   *
   * @param roomId - The room.
   * @param cascadeRoot - The entry id that began the cascade.
   */
  authorsInCascade(roomId: string, cascadeRoot: string): string[] {
    const rows = this.db
      .selectDistinct({ authorId: roomEntries.authorId })
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.cascadeRoot, cascadeRoot)))
      .all();
    return rows.map((row) => row.authorId);
  }

  // === Per-room agent sessions ===

  /**
   * The session an agent member answers in this room with, or `null` when it
   * has not answered here yet.
   *
   * @param roomId - The room.
   * @param authorId - The agent member.
   */
  getRoomSession(roomId: string, authorId: string): string | null {
    const row = this.db
      .select()
      .from(roomSessions)
      .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
      .get();
    return row?.sessionId ?? null;
  }

  /**
   * Bind an agent member's session for this room. First write wins, mirroring
   * the runtime binding it will carry (ADR-0255).
   *
   * @param roomId - The room.
   * @param authorId - The agent member.
   * @param sessionId - The session to bind.
   * @param createdAt - When the binding was made.
   * @returns The bound session id — the existing one when there already was one.
   */
  bindRoomSession(roomId: string, authorId: string, sessionId: string, createdAt: string): string {
    this.db
      .insert(roomSessions)
      .values({ roomId, authorId, sessionId, createdAt })
      .onConflictDoNothing()
      .run();
    return this.getRoomSession(roomId, authorId) ?? sessionId;
  }
}

export type { NewRoom, NewRoomEntry } from './room-rows.js';
