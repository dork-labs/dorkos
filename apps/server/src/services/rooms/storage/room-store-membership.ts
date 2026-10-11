import {
  authors,
  rooms,
  roomMembers,
  roomEntries,
  roomSessions,
  eq,
  and,
  inArray,
  lt,
  ne,
  sql,
  type DbTransaction,
} from '@dorkos/db';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomMember } from '@dorkos/shared/room-schemas';
import { toMember } from '../data/room-rows.js';
import { readOriginalRoomStoreMethodView } from '../room-store.js';

/** Original addMember responsibility after exact constructor-private store recognition. */
export function addMember(
  opaqueRoomStoreKey: object,
  member: {
    roomId: string;
    authorId: string;
    responseMode: ResponseMode;
    joinedAt: string;
  },
  tx?: DbTransaction
): RoomMember {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = { ...member, joinedSeq: facet.maxSeq(member.roomId), lastReadSeq: 0 };
  // The join and the room's member key are ONE write: a DM whose roster moved
  // without its key moving would leave `findDmByMemberSet` confidently
  // answering with a room that no longer holds those people (DOR-1616).
  facet.inOneTransaction(tx, (exec) => {
    exec.insert(roomMembers).values(row).onConflictDoNothing().run();
    facet.syncDmMemberKey(member.roomId, exec);
  });
  // Read back through `this.db` even inside a transaction, for the reason
  // `createRoom` records: one connection, so a read here sees the open
  // transaction's own uncommitted write.
  return facet.getMember(member.roomId, member.authorId) ?? toMember(row);
}

/** Original getMember responsibility after exact constructor-private store recognition. */
export function getMember(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string
): RoomMember | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
    .get();
  return row ? toMember(row) : null;
}

/** Original listMembers responsibility after exact constructor-private store recognition. */
export function listMembers(opaqueRoomStoreKey: object, roomId: string): RoomMember[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const rows = facet.db
    .select()
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(roomMembers.joinedAt, roomMembers.authorId)
    .all();
  return rows.map(toMember);
}

/** Original listMembersForRooms responsibility after exact constructor-private store recognition. */
export function listMembersForRooms(
  opaqueRoomStoreKey: object,
  roomIds: readonly string[]
): RoomMember[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  if (roomIds.length === 0) return [];
  const rows = facet.db
    .select()
    .from(roomMembers)
    .where(inArray(roomMembers.roomId, [...new Set(roomIds)]))
    .orderBy(roomMembers.roomId, roomMembers.joinedAt, roomMembers.authorId)
    .all();
  return rows.map(toMember);
}

/** Original listMembershipsFor responsibility after exact constructor-private store recognition. */
export function listMembershipsFor(opaqueRoomStoreKey: object, authorId: string): RoomMember[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const rows = facet.db.select().from(roomMembers).where(eq(roomMembers.authorId, authorId)).all();
  return rows.map(toMember);
}

/** Original roomsPostedInBy responsibility after exact constructor-private store recognition. */
export function roomsPostedInBy(opaqueRoomStoreKey: object, authorId: string): Set<string> {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const rows = facet.db
    .selectDistinct({ roomId: roomEntries.roomId })
    .from(roomEntries)
    .where(eq(roomEntries.authorId, authorId))
    .all();
  return new Set(rows.map((row) => row.roomId));
}

/** Original setResponseMode responsibility after exact constructor-private store recognition. */
export function setResponseMode(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string,
  responseMode: ResponseMode
): RoomMember | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  facet.db
    .update(roomMembers)
    .set({ responseMode })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
    .run();
  return facet.getMember(roomId, authorId);
}

/** Original setFallbackSeat responsibility after exact constructor-private store recognition. */
export function setFallbackSeat(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string | null
): Room | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  facet.db.update(rooms).set({ fallbackSeatAuthorId: authorId }).where(eq(rooms.id, roomId)).run();
  return facet.getRoom(roomId);
}

/** Original setReadCursor responsibility after exact constructor-private store recognition. */
export function setReadCursor(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string,
  lastReadSeq: number
): RoomMember | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  facet.db
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
  return facet.getMember(roomId, authorId);
}

/** Original rewindReadCursor responsibility after exact constructor-private store recognition. */
export function rewindReadCursor(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string,
  opts: { from: number; to: number }
): RoomMember | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  facet.db
    .update(roomMembers)
    .set({ lastReadSeq: opts.to })
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.authorId, authorId),
        eq(roomMembers.lastReadSeq, opts.from)
      )
    )
    .run();
  return facet.getMember(roomId, authorId);
}

/** Original removeMember responsibility after exact constructor-private store recognition. */
export function removeMember(
  opaqueRoomStoreKey: object,
  roomId: string,
  authorId: string
): boolean {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const existed = facet.getMember(roomId, authorId) !== null;
  // All three writes together, for the reason `addMember` gives: a roster that
  // moved without the room's member key moving is a key that describes people
  // who are no longer there.
  facet.inOneTransaction(undefined, (exec) => {
    exec
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
      .run();
    exec
      .delete(roomSessions)
      .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
      .run();
    facet.syncDmMemberKey(roomId, exec);
  });
  return existed;
}

/** Original listFormerAuthorIds responsibility after exact constructor-private store recognition. */
export function listFormerAuthorIds(opaqueRoomStoreKey: object, roomId: string): string[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  return facet.db
    .select({ id: authors.id })
    .from(authors)
    .where(
      and(
        ne(authors.kind, 'system'),
        sql`exists (select 1 from ${roomEntries} where ${roomEntries.authorId} = ${authors.id} and ${roomEntries.roomId} = ${roomId})`,
        sql`not exists (select 1 from ${roomMembers} where ${roomMembers.authorId} = ${authors.id} and ${roomMembers.roomId} = ${roomId})`
      )
    )
    .orderBy(authors.createdAt, authors.id)
    .all()
    .map((row) => row.id);
}
