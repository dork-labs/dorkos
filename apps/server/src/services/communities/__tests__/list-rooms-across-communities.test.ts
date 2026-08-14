/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import {
  LOCAL_COMMUNITY,
  type CommunityRef,
  type CommunityRoom,
} from '@dorkos/shared/community-adapter';
import type { ListRoomsQuery, RoomSummary } from '@dorkos/shared/room-schemas';
import { FakeCommunityAdapter } from '@dorkos/test-utils/fake-community-adapter';
import type { RoomService } from '../../rooms/room-service.js';
import { listRoomsAcrossCommunities } from '../list-rooms-across-communities.js';
import { CommunityRegistry } from '../registry.js';

/** A second community, addressed by a ULID the way a real one would be. */
const REMOTE = '01K1BXCQ4M7GKZ9V0S2R7XQ3AB' as CommunityRef;

/** One of this machine's rooms, as the room service reports it. */
function localRoom(id: string, lastActivityAt: string): RoomSummary {
  return {
    id,
    kind: 'channel',
    slug: id,
    title: id,
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 40,
    wellKnown: null,
    fallbackSeatAuthorId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActivityAt,
    unreadCount: 0,
    participants: null,
    working: 0,
    viewerHasPosted: true,
  };
}

/**
 * The one method this function asks of the room service, as a spy.
 *
 * Deliberately not a whole `RoomService`: the production signature takes a
 * `Pick`, so a stub that satisfies it is the honest shape rather than a cast.
 */
function roomService(rooms: RoomSummary[]): Pick<RoomService, 'listRooms'> {
  return { listRooms: vi.fn(() => rooms) };
}

/** A registry holding the local community, plus whatever else a test registers. */
function registryWithLocal(): { registry: CommunityRegistry; local: FakeCommunityAdapter } {
  const registry = new CommunityRegistry();
  const local = new FakeCommunityAdapter({ community: LOCAL_COMMUNITY, type: 'local' });
  registry.register(local, 'This machine');
  return { registry, local };
}

describe('listRoomsAcrossCommunities', () => {
  it("answers with this machine's rooms and no warnings when it is the only community", async () => {
    const { registry } = registryWithLocal();
    const rooms = [localRoom('general', '2026-08-10T00:00:00.000Z')];

    const result = await listRoomsAcrossCommunities({
      service: roomService(rooms),
      callerAuthorId: 'author-1',
      query: {},
      registry,
    });

    expect(result).toEqual({ rooms, warnings: [] });
  });

  it('asks the room service for the CALLER and the filter it was sent', async () => {
    // The reason this machine's rooms do not travel over the port: an adapter
    // instance serves one connected identity and `listRooms()` takes no
    // arguments, so neither of these two values could cross it. If this ever
    // stops holding, an agent is being shown the operator's rooms.
    const { registry } = registryWithLocal();
    const service = roomService([]);
    const query: ListRoomsQuery = { kind: 'dm', includeArchived: true };

    await listRoomsAcrossCommunities({
      service,
      callerAuthorId: 'agent-ana',
      query,
      registry,
    });

    expect(service.listRooms).toHaveBeenCalledWith('agent-ana', query);
  });

  it('never lists this machine through the port, even though it is registered', async () => {
    const { registry, local } = registryWithLocal();
    local.seedRoom({ entries: 1 });
    const listRooms = vi.spyOn(local, 'listRooms');

    const result = await listRoomsAcrossCommunities({
      service: roomService([localRoom('general', '2026-08-10T00:00:00.000Z')]),
      callerAuthorId: 'author-1',
      query: {},
      registry,
    });

    expect(listRooms, 'the local adapter is registered but not asked').not.toHaveBeenCalled();
    expect(result.rooms.map((room) => room.id)).toEqual(['general']);
  });

  it("aggregates a second community's rooms and says they are not available here", async () => {
    const { registry } = registryWithLocal();
    const remote = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    remote.seedRoom({ entries: 1 });
    remote.seedRoom({ entries: 1 });
    registry.register(remote, 'Dork Labs');

    const rooms = [localRoom('general', '2026-08-10T00:00:00.000Z')];
    const result = await listRoomsAcrossCommunities({
      service: roomService(rooms),
      callerAuthorId: 'author-1',
      query: {},
      registry,
    });

    // A remote room is not projected into `rooms`: nothing on this server
    // resolves a `(community, roomId)` pair, so it would render and then fail
    // on the click.
    expect(result.rooms).toEqual(rooms);
    expect(result.warnings).toEqual([
      {
        community: REMOTE,
        label: 'Dork Labs',
        message: "2 rooms in Dork Labs aren't available here.",
      },
    ]);
  });

  it('says nothing about a second community that has no rooms', async () => {
    const { registry } = registryWithLocal();
    registry.register(new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' }), 'Dork Labs');

    const result = await listRoomsAcrossCommunities({
      service: roomService([]),
      callerAuthorId: 'author-1',
      query: {},
      registry,
    });

    expect(result.warnings).toEqual([]);
  });

  it("degrades a broken community to a warning and still lists this machine's rooms", async () => {
    const { registry } = registryWithLocal();
    const broken = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    vi.spyOn(broken, 'listRooms').mockRejectedValue(new Error('relay closed the socket'));
    registry.register(broken, 'Dork Labs');

    const rooms = [localRoom('general', '2026-08-10T00:00:00.000Z')];
    const result = await listRoomsAcrossCommunities({
      service: roomService(rooms),
      callerAuthorId: 'author-1',
      query: {},
      registry,
    });

    expect(result.rooms, 'a broken community elsewhere does not empty the sidebar').toEqual(rooms);
    // Sanitized copy, not the adapter's own words — the schema promises "never
    // a raw protocol string" and a relay's refusal text is written by a server
    // we do not run.
    expect(result.warnings).toEqual([
      { community: REMOTE, label: 'Dork Labs', message: 'Dork Labs could not be reached.' },
    ]);
  });

  it('gives a slow community a budget rather than letting it stall the list', async () => {
    const { registry } = registryWithLocal();
    const slow = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    vi.spyOn(slow, 'listRooms').mockImplementation(
      () => new Promise<CommunityRoom[]>(() => {}) // never settles
    );
    registry.register(slow, 'Dork Labs');

    const result = await listRoomsAcrossCommunities({
      service: roomService([]),
      callerAuthorId: 'author-1',
      query: {},
      registry,
      timeoutMs: 20,
    });

    expect(result.warnings).toEqual([
      { community: REMOTE, label: 'Dork Labs', message: 'Dork Labs took too long to answer.' },
    ]);
  });

  it('counts one room as one room', async () => {
    const { registry } = registryWithLocal();
    const remote = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    remote.seedRoom({ entries: 1 });
    registry.register(remote, 'Dork Labs');

    const result = await listRoomsAcrossCommunities({
      service: roomService([]),
      callerAuthorId: 'author-1',
      query: {},
      registry,
    });

    expect(result.warnings[0]!.message).toBe("1 room in Dork Labs isn't available here.");
  });
});
