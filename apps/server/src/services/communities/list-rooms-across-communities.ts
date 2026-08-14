/**
 * The room list, across every community this install is in — what
 * `GET /api/rooms` answers with.
 *
 * This is the `CommunityAdapter` port's first production consumer. Until it
 * existed, {@link aggregateCommunityRooms} and the registry behind it were
 * conformance-tested infrastructure with nothing calling them, which is a seam
 * that can only drift (DOR-1204; `research/20260813_room-architecture-vs-buzz-qm.md`
 * §2, "dead seam").
 *
 * **This machine's own rooms do NOT travel over the port, and that is the
 * decision rather than an omission** (ADR `bridged-rooms-are-projections-not-communities`).
 * Three things stop them, and the first is the one that matters:
 *
 * 1. **The port is single-identity.** One adapter instance serves one connected
 *    member (`community-adapter.ts` rule 1), and `LOCAL_COMMUNITY` connects as
 *    whoever owns this install. `GET /api/rooms` is per-CALLER: an agent
 *    presenting `X-DorkOS-Agent` must see only the rooms it belongs to. Routing
 *    the local list through the registry's one instance would answer an agent
 *    with the operator's rooms — a visibility regression, not a shape change.
 * 2. **`listRooms()` takes no arguments**, so `?kind=` and `?includeArchived=`
 *    cannot cross it.
 * 3. **`CommunityRoom` is narrower than `RoomSummary`** — no `workspaceId`, no
 *    `ambientMaxEntries`, no `participants`, no `working`, no `viewerHasPosted`
 *    — and it names the id half of a `(community, roomId)` pair. Two of those
 *    fields have no honest value for a room on somebody else's server.
 *
 * So the local half is served exactly as it always was, byte for byte, and the
 * port serves the half only it can: every OTHER configured community, with the
 * per-community degradation ADR-0310 established. On an install that is only in
 * this one — every install today — the aggregation runs over an empty set and
 * answers `{ rooms: [], warnings: [] }`, which is the drift guard doing its job
 * quietly: it is compiled, executed and asserted on the path a person hits.
 *
 * @module services/communities/list-rooms-across-communities
 */
import { LOCAL_COMMUNITY } from '@dorkos/shared/community-adapter';
import type { ListRoomsQuery, RoomListResponse } from '@dorkos/shared/room-schemas';
import type { RoomService } from '../rooms/room-service.js';
import { aggregateCommunityRooms } from './aggregate-community-rooms.js';
import { communityRegistry, type CommunityRegistry } from './registry.js';

/**
 * Say that a community has rooms this surface does not show.
 *
 * A remote room is deliberately NOT projected into `rooms`: nothing on this
 * server resolves a `(community, roomId)` pair, so a listed remote room would
 * render, invite a click and fail — the same "reads as broken rather than as
 * changed" failure {@link aggregateCommunityRooms} suppresses a not-admitted
 * community's rooms to avoid. Saying so is the honest half, and it is what the
 * warning channel is for.
 *
 * The copy states what is true now and promises nothing about later: "aren't
 * available here" is a fact about this surface, where "can't open yet" would be
 * a roadmap commitment on a room list.
 *
 * @param label - What a person calls the community.
 * @param count - How many rooms it listed.
 */
function roomsNotShownHere(label: string, count: number): string {
  return count === 1
    ? `1 room in ${label} isn't available here.`
    : `${count} rooms in ${label} aren't available here.`;
}

/**
 * List the caller's rooms, and report every community that could not contribute.
 *
 * @param opts - Listing inputs.
 * @param opts.service - The room service serving this machine's own rooms. Narrowed
 *   to the one method this needs, so nothing here can quietly grow a second reason
 *   to hold the whole service.
 * @param opts.callerAuthorId - Whose rooms to list — the author `resolveCaller` resolved.
 * @param opts.query - The `kind` / `includeArchived` filter, as sent.
 * @param opts.registry - The community registry; defaults to the singleton.
 * @param opts.timeoutMs - Per-community budget, passed through to the aggregation.
 */
export async function listRoomsAcrossCommunities(opts: {
  service: Pick<RoomService, 'listRooms'>;
  callerAuthorId: string;
  query: ListRoomsQuery;
  registry?: CommunityRegistry;
  timeoutMs?: number;
}): Promise<RoomListResponse> {
  const { service, callerAuthorId, query, registry = communityRegistry, timeoutMs } = opts;

  const elsewhere = registry
    .entries()
    .filter((entry) => entry.descriptor.community !== LOCAL_COMMUNITY);

  // Synchronous, and started first: the local store is on this disk, so it can
  // never be the thing a remote community's budget is waiting on.
  const rooms = service.listRooms(callerAuthorId, query);
  const aggregated = await aggregateCommunityRooms({
    communities: elsewhere,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  // One line per community that listed something, not one per room: a person
  // needs to know a community is out of reach, not to read its table of
  // contents. Grouped rather than counted per source, because the aggregation
  // has already merged and sorted them.
  const counts = new Map<string, number>();
  for (const room of aggregated.rooms) {
    counts.set(room.community, (counts.get(room.community) ?? 0) + 1);
  }

  const unopenable = elsewhere.flatMap(({ descriptor }) => {
    const count = counts.get(descriptor.community) ?? 0;
    if (count === 0) return [];
    return [
      {
        community: descriptor.community,
        label: descriptor.label,
        message: roomsNotShownHere(descriptor.label, count),
      },
    ];
  });

  return { rooms, warnings: [...aggregated.warnings, ...unopenable] };
}
