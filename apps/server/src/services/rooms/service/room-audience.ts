/** Membership addressing for global room events. */
import type { BroadcastAudience } from '../../core/event-fan-out.js';
import { readOwnerAccount } from '../../core/auth/index.js';
import { resolveOperatorAuthor } from '../operator-author.js';
import type { RoomService } from '../room-service.js';

/**
 * Address global room events through the same membership gate as room reads.
 * Browser sessions currently belong only to the install owner; operator streams
 * therefore resolve that author. Multiuser browser sessions must carry their
 * verified user id in CallerPrincipal before this assumption can change.
 * A removed author receives only the removal notice, never subsequent events.
 */
export function roomAudience(
  roomId: string,
  rooms: {
    authorRegistry: RoomService['authorRegistry'];
    requireMembership(roomId: string, authorId: string): unknown;
  },
  removedAuthorId?: string
): BroadcastAudience {
  return (principal) => {
    // Agent streams carry no verified agent identity to resolve membership from.
    if (principal.kind !== 'operator' && principal.kind !== 'program') return false;
    try {
      const registry = rooms.authorRegistry;
      const author =
        principal.kind === 'operator' || principal.userId === readOwnerAccount()?.id
          ? resolveOperatorAuthor(registry)
          : registry.human(principal.userId);
      if (author.id === removedAuthorId) return true;
      rooms.requireMembership(roomId, author.id);
      return true;
    } catch {
      return false;
    }
  };
}
