/**
 * Who a channel post reached, said back to the agent that wrote it (DOR-3454).
 *
 * `post_to_room` returns "Woke @ana. Cc: @bo." beside the entry id, so an
 * author who meant to ask somebody and only copied them in can see it at once
 * and post again. The rule it reports is the one the dispatcher reads
 * ({@link addresseesOf}, {@link ccOf}), never a second reading of the text.
 *
 * Channels only: a DM keeps its own rule, where a post is for everyone in it
 * whether or not it names them, so "Woke nobody" would be false there.
 *
 * @module server/services/rooms/messages/post-reach
 */
import { reachLine } from '@dorkos/shared/mention-addressing';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { addresseesOf, ccOf } from '../mentions.js';
import type { RoomService } from '../room-service.js';

/**
 * The `reached` field of a post's result, or nothing outside a channel.
 *
 * @param rooms - The rooms service, for the room's kind and members' handles.
 * @param entry - The entry the post just wrote.
 * @returns `{ reached }` in a channel, `{}` anywhere else.
 */
export function reachOf(
  rooms: Pick<RoomService, 'getRoom' | 'authorRegistry' | 'nameForAgents'>,
  entry: Pick<RoomEntry, 'roomId' | 'authorId' | 'mentions' | 'mentionSpans'>
): { reached?: string } {
  if (rooms.getRoom(entry.roomId, entry.authorId)?.kind !== 'channel') return {};
  const named = (ids: readonly string[]) =>
    ids.filter((id) => id !== entry.authorId).map((id) => `@${handleOf(rooms, id)}`);
  // Only an agent wakes: a person named is told, and takes no turn.
  const agents = addresseesOf(entry).filter(
    (id) => rooms.authorRegistry.getById(id)?.kind === 'agent'
  );
  return { reached: reachLine(named(agents), named(ccOf(entry))) };
}

/**
 * A member's handle, or the name agents know them by when they have none.
 *
 * Sanitized: it lands in text another model reads.
 *
 * @param rooms - The rooms service, for its author registry.
 * @param authorId - The member to name.
 */
function handleOf(
  rooms: Pick<RoomService, 'authorRegistry' | 'nameForAgents'>,
  authorId: string
): string {
  const name = rooms.authorRegistry.getById(authorId)?.handle ?? rooms.nameForAgents(authorId);
  return (name ? sanitizeIdentity(name) : undefined) ?? 'somebody';
}
