/** Membership addressing for global room events and people's read cursors. */
import type { Db } from '@dorkos/db';
import type { BroadcastAudience } from '../../core/event-fan-out.js';
import { ReadCursorService, type ReadCursorMoved } from '../../core/read-cursor-service.js';
import { ReadCursorStore } from '../../core/read-cursor-store.js';
import type { CallerPrincipal } from '../../../lib/caller-principal.js';
import { readOwnerAccount } from '../../core/auth/index.js';
import { resolveOperatorAuthor } from '../operator-author.js';
import type { RoomService } from '../room-service.js';

/** The two room facts an audience reads, at delivery time. */
type RoomAudienceSource = {
  authorRegistry: RoomService['authorRegistry'];
  requireMembership(roomId: string, authorId: string): unknown;
};

/**
 * Address global room events through the same membership gate as room reads.
 * Browser sessions currently belong only to the install owner; operator streams
 * therefore resolve that author. Multiuser browser sessions must carry their
 * verified user id in CallerPrincipal before this assumption can change.
 * A removed author receives only the removal notice, never subsequent events.
 */
export function roomAudience(
  roomId: string,
  rooms: RoomAudienceSource,
  removedAuthorId?: string
): BroadcastAudience {
  return (principal) => {
    // Agent streams carry no verified agent identity to resolve membership from.
    if (principal.kind !== 'operator' && principal.kind !== 'program') return false;
    try {
      const author = personAuthor(principal, rooms.authorRegistry);
      if (author.id === removedAuthorId) return true;
      rooms.requireMembership(roomId, author.id);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Address a moved read cursor. Every cursor belongs to one person, so it goes
 * only to that person's streams, on every screen they have open. A room cursor
 * also passes the room's membership check, so a person who left the room hears
 * nothing more from it. Agent streams never receive one, even an agent seated
 * in the room.
 *
 * @param moved - The cursor that moved: whose it is, and in what thread.
 * @param rooms - Author and membership lookups, read when the frame is sent.
 * @returns A stream predicate that refuses anything it cannot resolve.
 */
export function readCursorAudience(
  moved: ReadCursorMoved,
  rooms: RoomAudienceSource
): BroadcastAudience {
  const inRoom = moved.threadKind === 'room' ? roomAudience(moved.threadId, rooms) : null;
  return (principal) => {
    if (principal.kind !== 'operator' && principal.kind !== 'program') return false;
    try {
      if (personAuthor(principal, rooms.authorRegistry).id !== moved.userId) return false;
    } catch {
      return false;
    }
    return inRoom ? inRoom(principal) : true;
  };
}

/**
 * The install's read-cursor service, addressed by {@link readCursorAudience}.
 *
 * @param db - The database holding the cursor table.
 * @param rooms - The rooms graph, asked for only when a cursor moves, so the
 *   service can be built before the graph that uses it.
 * @returns The service every read-cursor write goes through.
 */
export function roomReadCursors(db: Db, rooms: () => RoomAudienceSource): ReadCursorService {
  return new ReadCursorService(new ReadCursorStore(db), (moved) =>
    readCursorAudience(moved, rooms())
  );
}

/** The room author a person's stream speaks as; an account id is not an author id. */
function personAuthor(
  principal: Extract<CallerPrincipal, { kind: 'operator' | 'program' }>,
  registry: RoomService['authorRegistry']
) {
  return principal.kind === 'operator' || principal.userId === readOwnerAccount()?.id
    ? resolveOperatorAuthor(registry)
    : registry.human(principal.userId);
}
