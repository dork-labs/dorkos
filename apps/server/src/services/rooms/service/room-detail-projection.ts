/**
 * One room in full, as the `get_room` and `find_room` tools return it (moved out of
 * `room-capabilities.ts`, which uses it).
 *
 * @module services/rooms/service/room-detail-projection
 */
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import type { RoomDetail, RoomService } from '../room-service.js';

/**
 * One room in full, as `get_room` and `find_room` return it: the listing facts,
 * the topic, and the roster with every label sanitized.
 *
 * The member rows deliberately carry `authorId` — it is what history entries
 * name their writer by, so an agent can join "who said this" to "who is this"
 * without a guess. What they deliberately do NOT carry is the operator's
 * per-member configuration (response modes, read cursors): context spent on
 * fields a model cannot act on.
 *
 * **The topic is sanitized for safety and not for length**, the same idiom
 * `welcome-back/greeter.ts` uses: the sanitizer is asked only for the thing it
 * is for. A topic is already bounded where it is WRITTEN — `UpdateRoomRequest`
 * caps it at 500 characters — and this projection is built when an agent asks
 * after one room rather than on every turn, so neither the 200-character cut
 * `room-context-block.ts` makes for its per-turn preamble nor the identity
 * default of 80 belongs here. Eighty would silently halve an ordinary sentence,
 * and a second cap copied to this side of the seam is a number that drifts from
 * the schema and truncates in a place nobody would think to look.
 *
 * @param rooms - The rooms service, for naming each member as an agent reads them.
 * @param detail - The service's projection.
 * @returns The compact, label-sanitized shape a tool returns.
 */
export function projectDetail(rooms: RoomService, detail: RoomDetail): Record<string, unknown> {
  return {
    roomId: detail.roomId,
    kind: detail.kind,
    // `?? null` on every label, for the reason spelled out on the topic below:
    // a name written entirely in angle brackets sanitizes to nothing, and
    // `undefined` is a key JSON drops — so a room would arrive with no `name`
    // field at all and an agent would have nothing to call it by. `null` says
    // "there is a name here and none of it survived", which is the true one.
    name: sanitizeIdentity(detail.name) ?? null,
    // A topic written entirely in angle brackets sanitizes to nothing, and
    // reporting that as an absent key would say "nobody set a topic" when the
    // truth is "somebody set a topic I cannot show you". Two different facts,
    // and `null` is one of them.
    topic:
      detail.topic === null
        ? null
        : (sanitizeIdentity(detail.topic, Number.MAX_SAFE_INTEGER) ?? null),
    joined: detail.joinedAt,
    lastActivity: detail.lastActivityAt,
    members: detail.members.map((member) => ({
      authorId: member.authorId,
      // The owner by name, never the registry's 'You' (DOR-2458).
      name: sanitizeIdentity(rooms.nameForAgents(member.authorId) ?? member.name) ?? null,
      ...(member.handle ? { handle: sanitizeIdentity(member.handle) } : {}),
      kind: member.kind,
    })),
  };
}

/**
 * How a member is named in a canvas answer — their handle when they have one.
 *
 * Sanitized like every other label this seam hands back: it lands in text
 * another model reads.
 *
 * @param rooms - The rooms service, for its author registry.
 * @param authorId - The member to name.
 * @returns A short label.
 */
export function authorLabel(rooms: RoomService, authorId: string): string {
  const author = rooms.authorRegistry.getById(authorId);
  const name = author?.handle ?? rooms.nameForAgents(authorId);
  return (name ? sanitizeIdentity(name) : undefined) ?? 'Somebody';
}
