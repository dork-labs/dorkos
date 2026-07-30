/**
 * @vitest-environment node
 *
 * The registry's own guarantee: **`LOCAL_COMMUNITY` is always registered.**
 *
 * The spec states it twice and nothing held it up — a fresh registry was empty,
 * and asking it for the one community that certainly exists raised
 * `CommunityNotRegisteredError`. This is the test that was missing, and it is
 * about the wiring rather than the adapter: it asserts what a caller finds in
 * the registry after startup has run, which is the only place the guarantee can
 * be true or false.
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_COMMUNITY } from '@dorkos/shared/community-adapter';
import { CommunityRegistry } from '../../registry.js';
import { RoomStore } from '../../../rooms/room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import {
  LOCAL_COMMUNITY_LABEL,
  localCommunityIdentity,
  registerLocalCommunity,
} from '../register-local-community.js';

/** A wired install plus the pieces registration takes. */
function install(): {
  harness: RoomHarness;
  register: (registry: CommunityRegistry) => Promise<unknown>;
} {
  const harness = createRoomHarness({ agents: agentLookupFor({}) });
  return {
    harness,
    register: (registry) =>
      registerLocalCommunity({
        service: harness.service,
        store: new RoomStore(harness.db),
        authors: harness.authors,
        registry,
      }),
  };
}

describe('registerLocalCommunity', () => {
  it('leaves LOCAL_COMMUNITY present, named, and connected', async () => {
    const registry = new CommunityRegistry();
    const { harness, register } = install();

    // The state the guarantee is measured against: before startup wiring runs,
    // the registry genuinely does not have it.
    expect(registry.has(LOCAL_COMMUNITY)).toBe(false);

    await register(registry);

    expect(registry.has(LOCAL_COMMUNITY), 'the local community is always registered').toBe(true);
    expect(registry.list()).toEqual([
      { community: LOCAL_COMMUNITY, label: LOCAL_COMMUNITY_LABEL, type: 'local' },
    ]);
    // Connect is driven at registration rather than left to the first caller,
    // because a listing needs the result: a community that did not connect
    // contributes a warning instead of rooms.
    expect(registry.getConnection(LOCAL_COMMUNITY)).toEqual({
      status: 'connected',
      identity: { community: LOCAL_COMMUNITY, memberId: harness.human },
    });
  });

  it('declares the capabilities the local backend actually has', async () => {
    const registry = new CommunityRegistry();
    await install().register(registry);

    const capabilities = registry.getCapabilities()[LOCAL_COMMUNITY]!;
    expect(capabilities).toMatchObject({
      type: 'local',
      roomList: 'push',
      roomAddressing: 'slug',
      canPost: true,
      roomAdmin: true,
      roles: { supported: false, values: [] },
      admission: 'open',
      invite: 'none',
      agentAdmission: 'none',
      readCursor: 'server',
      responseMode: true,
      threadDepth: 1,
      // Not 'both': the room signal envelope carries no presence payload yet,
      // and `'both'` now means round-tripping one. See the adapter's module doc.
      signals: 'none',
      credential: 'none',
    });
  });

  it('registers a community whose rooms it can already list', async () => {
    const registry = new CommunityRegistry();
    const { harness, register } = install();
    harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      harness.human
    );

    await register(registry);

    const rooms = await registry.get(LOCAL_COMMUNITY).listRooms();
    expect(rooms.map((room) => room.title)).toEqual(['Backend']);
    expect(rooms[0]!.community).toBe(LOCAL_COMMUNITY);
  });
});

describe('localCommunityIdentity', () => {
  it('answers with the unbound local author while nobody owns the install', () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    expect(localCommunityIdentity(harness.authors)()).toBe(harness.human);
  });

  it('keeps the same author id once an owner account exists', () => {
    // The whole point of the opaque-id indirection: turning login on binds the
    // account to the author already holding every room, membership and cursor.
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const resolve = localCommunityIdentity(harness.authors);
    const before = resolve();
    expect(harness.setOwner('owner-account-1')).toBe(before);
  });
});
