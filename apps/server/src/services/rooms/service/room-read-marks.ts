/**
 * A room read that hands an agent words from outside the team marks the turn that read them
 * (DOR-3969, spec §4.7): `read_room_history`, `search_room_history` and `search_member_rooms`.
 * Only when what came back holds such words, by the same rule a room turn answering those posts is
 * marked by (`turn-ceiling.ts`): a stranger on a bridged chat, a non-owner person (behind the same
 * boot flag), a mini app's post or a comment it forwarded, a post held for who was calling, or one
 * written from a chat that had read outside words. A read of the team's own posts stays clean.
 *
 * The room lookups (`list_member_rooms`, `get_room`, `find_room`) return names, not posts. They mark
 * when a room returned has a member on a bridged chat, whose display name (and a bridged direct
 * message's title) a stranger wrote.
 *
 * A check that cannot be made marks: an unreadable answer fails closed.
 *
 * @module services/rooms/service/room-read-marks
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { env } from '../../../env.js';
import { readOwnerAccount } from '../../core/auth/index.js';
import {
  markCallerTurnOutsider,
  type CallerTurn,
} from '../../core/capabilities/mark-caller-turn.js';
import {
  answersOutsideWords,
  isEntryAuthorExternal,
  strangerMarkForEntries,
} from '../limits/turn-ceiling.js';
import type {
  MemberRoomMatch,
  MemberRoomSummary,
  RoomDetail,
} from '../manage/room-member-directory.js';
import { projectDetail } from './room-detail-projection.js';
import type { RoomService } from '../room-service.js';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { projectEntry } from './room-entry-projection.js';

/** One message a read returned, with the room it is in. */
export interface ReadMessage {
  roomId: string;
  entry: RoomEntry;
}

/**
 * Whether any message a read returned holds words from outside the team.
 *
 * @param rooms - The rooms service, for its author records.
 * @param read - The messages, each with its room.
 */
export function readHoldsOutsideWords(rooms: RoomService, read: readonly ReadMessage[]): boolean {
  try {
    const authors = rooms.authorRegistry;
    const ownerId = readOwnerAccount()?.id ?? null;
    const isOwner = (authorId: string) => authors.isOwner(authorId, ownerId);
    const byRoom = new Map<string, RoomEntry[]>();
    for (const { roomId, entry } of read)
      byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), entry]);
    return [...byRoom].some(
      ([roomId, entries]) =>
        strangerMarkForEntries(env.DORKOS_MARK_STRANGER_TURNS, authors, entries, isOwner, roomId)
          .carriedOutsider === true || answersOutsideWords(authors, entries, roomId)
    );
  } catch {
    return true;
  }
}

/**
 * Mark the caller's turn when a room read returned outside words, and project what it returned.
 *
 * @param rooms - The rooms service.
 * @param caller - The verified call.
 * @param roomId - The room read.
 * @param entries - What the read returned.
 */
export function projectRead(
  rooms: RoomService,
  caller: CallerTurn,
  roomId: string,
  entries: readonly RoomEntry[]
): Record<string, unknown>[] {
  markIfOutside(
    rooms,
    caller,
    entries.map((entry) => ({ roomId, entry }))
  );
  return entries.map((entry) => projectEntry(rooms, entry));
}

/**
 * Mark the caller's turn when a search across rooms returned outside words, and project each match
 * with the room it came from.
 *
 * @param rooms - The rooms service.
 * @param caller - The verified call.
 * @param matches - What the search returned.
 */
export function projectMemberMatches(
  rooms: RoomService,
  caller: CallerTurn,
  matches: readonly MemberRoomMatch[]
): Record<string, unknown>[] {
  markIfOutside(rooms, caller, matches);
  return matches.map((match) => ({
    roomId: match.roomId,
    room: sanitizeIdentity(match.name),
    ...projectEntry(rooms, match.entry),
  }));
}

/** Mark the caller's turn when anything a read returned holds outside words. */
function markIfOutside(rooms: RoomService, caller: CallerTurn, read: readonly ReadMessage[]): void {
  if (read.length > 0 && readHoldsOutsideWords(rooms, read)) markCallerTurnOutsider(caller);
}

/** Whether any of these rooms has a member on a bridged chat, or one nobody can resolve. */
function roomsHoldOutsideNames(rooms: RoomService, details: readonly RoomDetail[]): boolean {
  try {
    return details.some((detail) =>
      detail.members.some((member) => isEntryAuthorExternal(rooms.authorRegistry, member.authorId))
    );
  } catch {
    return true;
  }
}

/**
 * Mark the caller's turn when a room it looked up has a bridged member, and project the rooms.
 *
 * @param rooms - The rooms service.
 * @param caller - The verified call.
 * @param details - The rooms returned, in full.
 */
export function projectRoomsRead(
  rooms: RoomService,
  caller: CallerTurn,
  details: readonly RoomDetail[]
): Record<string, unknown>[] {
  if (roomsHoldOutsideNames(rooms, details)) markCallerTurnOutsider(caller);
  return details.map((detail) => projectDetail(rooms, detail));
}

/**
 * Mark the caller's turn when a room in its member list has a bridged member, and project the list.
 * A room's name is typed by a person and read by a model, so it goes through the same sanitizer
 * every other label does, and lands on `null` when nothing survives it, as `projectDetail` does.
 *
 * @param rooms - The rooms service.
 * @param caller - The verified call.
 * @param viewer - The caller's author id.
 * @param listed - The caller's member rooms.
 */
export function projectMemberRoomList(
  rooms: RoomService,
  caller: CallerTurn,
  viewer: string,
  listed: readonly MemberRoomSummary[]
): Record<string, unknown>[] {
  let outside: boolean;
  try {
    outside = roomsHoldOutsideNames(
      rooms,
      listed.map((room) => rooms.describeRoom(room.roomId, viewer))
    );
  } catch {
    outside = true;
  }
  if (outside) markCallerTurnOutsider(caller);
  return listed.map((room) => ({
    roomId: room.roomId,
    kind: room.kind,
    name: sanitizeIdentity(room.name) ?? null,
    joined: room.joinedAt,
    lastActivity: room.lastActivityAt,
  }));
}
