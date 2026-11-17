/**
 * A room read that hands an agent words from outside the team marks the turn that read them
 * (DOR-3969, spec §4.7): `read_room_history`, `search_room_history` and `search_member_rooms`.
 * Only when what came back holds such words, by the same rule a room turn answering those posts is
 * marked by (`turn-ceiling.ts`): a stranger on a bridged chat, a non-owner person (behind the same
 * boot flag), a mini app's post or a comment it forwarded, a post held for who was calling, or one
 * written from a chat that had read outside words. A read of the team's own posts stays clean.
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
import { answersOutsideWords, strangerMarkForEntries } from '../limits/turn-ceiling.js';
import type { MemberRoomMatch } from '../manage/room-member-directory.js';
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
