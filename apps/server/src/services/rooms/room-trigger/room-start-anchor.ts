/**
 * What an aside is about in a room nobody has posted in yet (DOR-4619).
 *
 * Every turn is about an entry: it frames the turn's context, its claim and its working
 * indicator. A room hand-off is about the newest entry, and an empty room has none, so a post an
 * agent handed to its seat in a quiet room was refused as "nothing to answer". The anchor stands
 * in for that entry: the room's start, before its first line. It is never stored, so nothing can
 * react to it, thread under it or read it back, and the two places that would follow its id to a
 * stored entry ask {@link isRoomStartAnchor} first.
 *
 * @module server/services/rooms/room-trigger/room-start-anchor
 */
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';

/** The prefix no stored entry's id carries: a stored id is a ULID. */
const ROOM_START_PREFIX = 'room-start:';

/**
 * The room's start, as the entry an aside in an empty room is about.
 *
 * @param room - The room nobody has posted in yet.
 * @param authorId - The agent taking the turn, so the anchor names no other author.
 * @returns An entry that is never stored, at seq 0, before the room's first line.
 */
export function roomStartAnchor(room: Room, authorId: string): RoomEntry {
  const id = `${ROOM_START_PREFIX}${room.id}`;
  return {
    roomId: room.id,
    seq: 0,
    id,
    authorId,
    kind: 'notice',
    body: { text: '' },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: room.createdAt,
  };
}

/**
 * Whether an entry id is a room's start rather than a stored entry.
 *
 * @param entryId - The id a claim or a turn carries.
 */
export function isRoomStartAnchor(entryId: string): boolean {
  return entryId.startsWith(ROOM_START_PREFIX);
}
