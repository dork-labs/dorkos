import {
  DEFAULT_AMBIENT_MAX_ENTRIES,
  canonicalDmMemberKey,
  rooms,
  roomMembers,
  eq,
  and,
  desc,
  type DbTransaction,
} from '@dorkos/db';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomKind } from '@dorkos/shared/room-schemas';
import { toRoom, type NewRoom } from '../data/room-rows.js';
import { readOriginalRoomStoreMethodView } from '../room-store.js';

/** Original createRoom responsibility after exact constructor-private store recognition. */
export function createRoom(
  opaqueRoomStoreKey: object,
  room: NewRoom,
  members: ReadonlyArray<{ authorId: string; responseMode: ResponseMode; joinedAt: string }>,
  within?: (tx: DbTransaction) => void
): Room {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const { bridged = false, ...columns } = room;
  const row = {
    ...columns,
    wellKnown: room.wellKnown ?? null,
    // Computed HERE, from the roster this call is about to write, rather than
    // handed in by the caller (DOR-1616). The key and the memberships have to
    // describe the same set of people, and the only way to guarantee that is
    // to derive one from the other in the transaction that writes both — a
    // caller-supplied key would be a second expression of the member set,
    // free to disagree with the rows beside it.
    dmMemberKey: facet.dmMemberKeyFor(room.kind, bridged, members),
    // Whoever opened a channel picks its lead, defaulting to the first agent
    // added (DOR-2823); #team's is assigned by the boot hook that resolves the
    // default agent.
    leadAuthorId: room.leadAuthorId ?? null,
    archived: false,
    ambientMaxEntries: DEFAULT_AMBIENT_MAX_ENTRIES,
    // Inheriting, always: a room is created with no opinion of its own about
    // automatic-reply limits, so it follows Settings until somebody says
    // otherwise (DOR-1429). Written explicitly rather than left to the column
    // default because this literal is also what `toRoom` hands back, and a
    // created room must read exactly as a re-fetched one does.
    turnLimitsEnabled: null,
    maxAgentDepth: null,
    maxTurnsPerAgentPerCascade: null,
    maxAutoTurnsPerHour: null,
    lastActivityAt: room.createdAt,
  };
  facet.db.transaction(
    (tx) => {
      tx.insert(rooms).values(row).run();
      for (const member of members) {
        tx.insert(roomMembers)
          // Both seqs are 0 by construction rather than by default: a room
          // being created holds no entries yet, so nobody seeded onto its
          // roster has anything behind them or anything to have read.
          .values({ ...member, roomId: room.id, joinedSeq: 0, lastReadSeq: 0 })
          .onConflictDoNothing()
          .run();
      }
      within?.(tx);
    },
    { behavior: 'immediate' }
  );
  return toRoom(row);
}

/** Original getRoom responsibility after exact constructor-private store recognition. */
export function getRoom(opaqueRoomStoreKey: object, id: string): Room | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db.select().from(rooms).where(eq(rooms.id, id)).get();
  return row ? toRoom(row) : null;
}

/** Original listRooms responsibility after exact constructor-private store recognition. */
export function listRooms(
  opaqueRoomStoreKey: object,
  filter: { kind?: RoomKind; includeArchived?: boolean } = {}
): Room[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const conditions = [];
  if (filter.kind) conditions.push(eq(rooms.kind, filter.kind));
  if (!filter.includeArchived) conditions.push(eq(rooms.archived, false));
  const rows = facet.db
    .select()
    .from(rooms)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(rooms.lastActivityAt), desc(rooms.id))
    .all();
  return rows.map(toRoom);
}

/** Original listRoomsForMember responsibility after exact constructor-private store recognition. */
export function listRoomsForMember(
  opaqueRoomStoreKey: object,
  memberAuthorId: string,
  filter: { kind?: RoomKind; includeArchived?: boolean } = {}
): Room[] {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const conditions = [eq(roomMembers.authorId, memberAuthorId)];
  if (filter.kind) conditions.push(eq(rooms.kind, filter.kind));
  if (!filter.includeArchived) conditions.push(eq(rooms.archived, false));
  const rows = facet.db
    .select({ room: rooms })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .where(and(...conditions))
    .orderBy(desc(rooms.lastActivityAt), desc(rooms.id))
    .all();
  return rows.map((row) => toRoom(row.room));
}

/** Original findDmByMemberSet responsibility after exact constructor-private store recognition. */
export function findDmByMemberSet(
  opaqueRoomStoreKey: object,
  authorIds: readonly string[]
): Room | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const key = canonicalDmMemberKey(authorIds);
  if (key === '') return null;
  const row = facet.db
    .select()
    .from(rooms)
    // `kind` is redundant given that only a DM ever carries a key, and it is
    // here so the predicate MATCHES the partial index's own — which is what
    // lets the planner use it rather than scanning.
    .where(and(eq(rooms.kind, 'dm'), eq(rooms.dmMemberKey, key)))
    .get();
  return row ? toRoom(row) : null;
}

/** Original findLiveChannelBySlug responsibility after exact constructor-private store recognition. */
export function findLiveChannelBySlug(opaqueRoomStoreKey: object, slug: string): Room | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db
    .select()
    .from(rooms)
    .where(and(eq(rooms.slug, slug), eq(rooms.kind, 'channel'), eq(rooms.archived, false)))
    .get();
  return row ? toRoom(row) : null;
}

/** Original anyChannelHoldsSlug responsibility after exact constructor-private store recognition. */
export function anyChannelHoldsSlug(opaqueRoomStoreKey: object, slug: string): boolean {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  return (
    facet.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.slug, slug), eq(rooms.kind, 'channel')))
      .get() !== undefined
  );
}

/** Original findByWellKnown responsibility after exact constructor-private store recognition. */
export function findByWellKnown(opaqueRoomStoreKey: object, key: string): Room | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  const row = facet.db.select().from(rooms).where(eq(rooms.wellKnown, key)).get();
  return row ? toRoom(row) : null;
}

/** Original updateRoom responsibility after exact constructor-private store recognition. */
export function updateRoom(
  opaqueRoomStoreKey: object,
  id: string,
  patch: {
    title?: string;
    slug?: string;
    topic?: string | null;
    archived?: boolean;
    turnLimitsEnabled?: boolean | null;
    maxAgentDepth?: number | null;
    maxTurnsPerAgentPerCascade?: number | null;
    maxAutoTurnsPerHour?: number | null;
  }
): Room | null {
  const facet = readOriginalRoomStoreMethodView(opaqueRoomStoreKey);
  if (Object.keys(patch).length > 0) {
    facet.db.update(rooms).set(patch).where(eq(rooms.id, id)).run();
  }
  return facet.getRoom(id);
}
