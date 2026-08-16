/**
 * The rooms one roster member is in (spec `profile-unification` §3.2).
 *
 * A **read-only join across the two id spaces the roster straddles**, and that
 * join is the entire reason this module exists rather than the rooms domain
 * answering directly. `GET /api/team` hands out two kinds of id — a person's is
 * their `authors` row id, an agent's is its mesh manifest ULID — while
 * `room_members` knows only author ids. Somebody has to translate, and the only
 * place that already holds both halves of that mapping is `services/identity/`,
 * beside {@link aggregateTeamRoster} which builds the ids in the first place.
 * A room store that knew about manifest ULIDs, or a mesh that knew about author
 * rows, would each be a domain reaching into the other.
 *
 * It writes nothing, mints nothing and resolves nothing into existence — the
 * same discipline the roster keeps. An id it cannot place is answered as "no
 * such member" rather than minted into one.
 *
 * @module server/services/identity/member-rooms
 */
import type { MemberRoomsResponse } from '@dorkos/shared/team-schemas';
import type { Room, RoomMember } from '@dorkos/shared/room-schemas';
import type { AuthorRecord } from '../rooms/author-registry.js';

/**
 * What this read is made of. Every one of them is a read, narrowed to the
 * method actually used — the same shape `TeamMeshReader` takes in
 * `routes/team.ts`, so a caller wires registries rather than whole subsystems.
 */
export interface MemberRoomsSources {
  /**
   * Every ACTIVE human author — `AuthorRegistry.listActive('human')`, exactly
   * the read the roster's person rows come from.
   *
   * A list scanned for one id rather than `getById`, and that is the point:
   * `getById` answers for retired rows too, and `AuthorRecord` carries no
   * `retiredAt` for a caller to filter on. Asking the same question the roster
   * asked is the only way this endpoint cannot answer for somebody the roster
   * does not list.
   */
  listPeople: () => AuthorRecord[];
  /**
   * Every ACTIVE agent author, for the manifest-ULID join.
   *
   * The same read {@link aggregateTeamRoster} joins its agent rows through, and
   * active for the same reason: a directory that has changed hands leaves a
   * retired row whose stamp names an occupant that is gone, and answering for it
   * would hand back the previous agent's rooms under the new one's id.
   *
   * A scan rather than an indexed lookup because `minted_for_manifest_id` has
   * no index and the fleet on one install is a few dozen rows — an index for a
   * single profile page's read would be the wrong trade.
   */
  listAgentAuthors: () => AuthorRecord[];
  /** `RoomStore.listRoomsForMember` — non-archived, newest activity first. */
  listRoomsForAuthor: (authorId: string) => Room[];
  /** `RoomStore.listMembersForRooms` — every roster in one query, for the counts. */
  listMembersForRooms: (roomIds: readonly string[]) => RoomMember[];
  /**
   * Whether the mesh has an agent registered under this id.
   *
   * The second half of "is this member real", and it is not optional
   * politeness: an agent gets its author row the first time it is in a room, so
   * a freshly registered one is on the roster with no author row at all. Without
   * this the honest answer "you are in no rooms yet" would arrive as a 404 on
   * every new agent's profile.
   */
  isRegisteredAgent: (memberId: string) => boolean;
}

/**
 * Resolve a roster member id to the author row whose memberships answer for it.
 *
 * Two id spaces, checked in the order the roster produces them:
 *
 * 1. A **person**'s member id IS their author row id, so an active human row
 *    under that id settles it.
 * 2. An **agent**'s member id is its manifest ULID (a system agent included),
 *    whose author row carries it as `mintedForManifestId`.
 *
 * An agent's own AUTHOR id is deliberately not accepted: the roster never hands
 * one out, so honouring it would be a third id space nothing produces and
 * everything would have to keep supporting.
 *
 * @param memberId - The id `GET /api/team` returned for this member.
 * @param sources - See {@link MemberRoomsSources}.
 * @returns The author id, or `null` when no author row answers for this member.
 */
function resolveMemberAuthorId(memberId: string, sources: MemberRoomsSources): string | null {
  const person = sources.listPeople().find((record) => record.id === memberId);
  if (person) return person.id;

  const agent = sources
    .listAgentAuthors()
    .find((record) => record.mintedForManifestId === memberId);
  return agent?.id ?? null;
}

/**
 * List the rooms a roster member belongs to.
 *
 * Archived rooms are out (the store's default): a profile lists where somebody
 * can be found, and a room that has been put away is not that.
 *
 * @param memberId - The id `GET /api/team` returned for this member.
 * @param sources - See {@link MemberRoomsSources}.
 * @returns The member's rooms, or `null` when this install has never heard of
 *   the id — which the route turns into a 404. A member who is simply in no
 *   rooms gets `{ rooms: [] }`; the two are different sentences on a profile
 *   and the caller must be able to tell them apart.
 */
export function listMemberRooms(
  memberId: string,
  sources: MemberRoomsSources
): MemberRoomsResponse | null {
  const authorId = resolveMemberAuthorId(memberId, sources);
  if (authorId === null) {
    // No author row — real only if the mesh knows the id. See
    // `MemberRoomsSources.isRegisteredAgent` for why that is a case and not a
    // courtesy.
    return sources.isRegisteredAgent(memberId) ? { rooms: [] } : null;
  }

  const rooms = sources.listRoomsForAuthor(authorId);
  if (rooms.length === 0) return { rooms: [] };

  // One query for every roster rather than one per room — the same N+1 the room
  // list refuses, on a page that opens beside a roster read already in flight.
  const counts = new Map<string, number>();
  for (const member of sources.listMembersForRooms(rooms.map((room) => room.id))) {
    counts.set(member.roomId, (counts.get(member.roomId) ?? 0) + 1);
  }

  return {
    rooms: rooms.map((room) => ({
      id: room.id,
      name: room.title,
      // Carried rather than rendered into `#slug` here: the cockpit's
      // `roomName` owns that rule, and deciding it server-side would be a
      // second copy of it. `null` for a DM.
      slug: room.slug,
      kind: room.kind,
      // A room this member is in always has at least them on its roster, so the
      // fallback is unreachable — and it stays, because "unreachable" is a claim
      // about a join staying consistent rather than about this function.
      memberCount: counts.get(room.id) ?? 0,
    })),
  };
}
