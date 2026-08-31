import { describe, expect, it } from 'vitest';
import {
  CommunityUnsupportedError,
  StaleCommunityCursorError,
  type CommunityAdapter,
  type CommunityCapabilities,
  type CommunityCursor,
  type CommunityMember,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import { communityConformance } from '../community-conformance.js';
import { assertImported } from '../community-conformance-support.js';
import { FakeCommunityAdapter } from '../fake-community-adapter.js';

// FakeCommunityAdapter is the reference "passing" backend for the shared
// CommunityAdapter conformance suite. Running it across the whole flag matrix —
// not only the profiles our own two backends use — is what proves the suite
// bakes in no backend assumptions, so the same assertions must pass against the
// local rooms adapter, a read-only Buzz relay, and apps/community.

/** The credential every fake in this file holds and none may return. */
const PLANTED = 'planted-credential-do-not-leak';

/** Build a fake with one capability profile, wired for the required hooks. */
function make(capabilities: Partial<Omit<CommunityCapabilities, 'type'>> = {}) {
  return () => new FakeCommunityAdapter({ capabilities, plantedCredential: PLANTED });
}

/**
 * The shared hook set. `seedRoom` arranges out of band, so a `canPost: false`
 * profile still has something to read — the honest cost of a read-only backend.
 */
function hooks(capabilities: Partial<Omit<CommunityCapabilities, 'type'>> = {}) {
  return {
    plantedCredential: PLANTED,
    seedRoom: (adapter: CommunityAdapter) =>
      Promise.resolve((adapter as FakeCommunityAdapter).seedRoom({ entries: 3 })),
    // Supplied for every profile, not only the ones that could make their own
    // with `createRoom`: the empty-room cursor is exactly the case a read-only
    // backend never arranges by accident.
    seedEmptyRoom: (adapter: CommunityAdapter) =>
      Promise.resolve((adapter as FakeCommunityAdapter).seedRoom({ entries: 0 })),
    makeUnreachableAdapter: () =>
      new FakeCommunityAdapter({ capabilities, connectStatus: 'unreachable' }),
    makeUnadmittedAdapter: () =>
      new FakeCommunityAdapter({ capabilities, connectStatus: 'not-admitted' }),
    makeUnauthorizedAdapter: () =>
      new FakeCommunityAdapter({ capabilities, connectStatus: 'unauthorized' }),
    revokeOwner: (adapter: CommunityAdapter, ownerMemberId: string) => {
      (adapter as FakeCommunityAdapter).removeCommunityMember(ownerMemberId);
      return Promise.resolve();
    },
    makeEvictedRoom: (adapter: CommunityAdapter, roomId: string) => {
      (adapter as FakeCommunityAdapter).evictRoom(roomId, 'access-revoked');
      return Promise.resolve('access-revoked' as const);
    },
    // The port has no post-as-agent, so the entry an agent wrote is arranged out
    // of band — the same way a read-only backend arranges anything at all.
    seedAgentEntry: (adapter: CommunityAdapter, roomId: string, agent: CommunityMember) =>
      Promise.resolve(
        (adapter as FakeCommunityAdapter).seedEntry(roomId, {
          text: 'the agent speaking for itself',
          authorId: agent.memberId,
        }).id
      ),
    secondCommunity: () =>
      new FakeCommunityAdapter({
        capabilities,
        community: 'B0000000000000000000000001' as CommunityRef,
      }),
  };
}

// 1. Everything on — the local rooms shape, plus the roles and invites
//    apps/community adds.
communityConformance(make(), {
  name: 'FakeCommunityAdapter (everything on) — conformance',
  ...hooks(),
});

// 2. The read-only relay shape: no posting, no room admin, no read cursor, no
//    addressing override, no signals, poll discovery, opaque ids, unbounded
//    threads, five roles with a non-administering Bot. This is the profile the
//    whole design exists for — a backend with no invites and no read cursors
//    must pass WITHOUT any assertion being softened for the other two.
const READ_ONLY_RELAY: Partial<Omit<CommunityCapabilities, 'type'>> = {
  roomList: 'poll',
  roomListPollIntervalMs: 20,
  roomAddressing: 'opaque-id',
  canPost: false,
  roomAdmin: false,
  roles: {
    supported: true,
    values: [
      { id: 'owner', label: 'Owner', administers: true, isOwner: true },
      { id: 'admin', label: 'Admin', administers: true },
      { id: 'moderator', label: 'Moderator', administers: true },
      { id: 'member', label: 'Member', administers: false },
      { id: 'bot', label: 'Bot', administers: false },
    ],
  },
  admission: 'out-of-band',
  invite: 'none',
  agentAdmission: 'none',
  readCursor: 'none',
  responseMode: false,
  threadDepth: 'unbounded',
  signals: 'none',
  credential: 'machine-managed',
};
communityConformance(make(READ_ONLY_RELAY), {
  name: 'FakeCommunityAdapter (read-only relay: no invites, no read cursors, no signals) — conformance',
  ...hooks(READ_ONLY_RELAY),
});

// 3. A single-person local install: no roles at all, nothing to invite anyone
//    to, no agent to vouch to, no credential to hold.
const SOLO_LOCAL: Partial<Omit<CommunityCapabilities, 'type'>> = {
  roles: { supported: false, values: [] },
  admission: 'open',
  invite: 'none',
  agentAdmission: 'none',
  credential: 'none',
};
communityConformance(make(SOLO_LOCAL), {
  name: 'FakeCommunityAdapter (solo local: no roles, no invites) — conformance',
  ...hooks(SOLO_LOCAL),
});

// 4. A combination none of the three real backends uses: a community-scoped
//    invite (so the room-scoped request must be REFUSED rather than widened)
//    over a client-opaque read cursor (so unreadCount is null everywhere).
const COMMUNITY_INVITE_OPAQUE_CURSOR: Partial<Omit<CommunityCapabilities, 'type'>> = {
  invite: 'community',
  readCursor: 'client-opaque',
  admission: 'invite',
  threadDepth: 'unbounded',
  credential: 'user-account',
};
communityConformance(make(COMMUNITY_INVITE_OPAQUE_CURSOR), {
  name: 'FakeCommunityAdapter (community invite + client-opaque cursor) — conformance',
  ...hooks(COMMUNITY_INVITE_OPAQUE_CURSOR),
});

// ---------------------------------------------------------------------------
// Guards: the assertions above are only worth having if a wrong adapter fails
// them. Each case below breaks exactly one property and shows the suite's own
// mechanism rejecting it.
// ---------------------------------------------------------------------------

describe('communityConformance discriminates', () => {
  it('rejects a foreign cursor EAGERLY — the throw lands at call time, not on first pull', async () => {
    assertImported(StaleCommunityCursorError, 'StaleCommunityCursorError');
    const adapter = new FakeCommunityAdapter();
    await adapter.connect();
    const roomA = adapter.seedRoom({ entries: 2 });
    const roomB = adapter.seedRoom({ entries: 2 });
    const foreign = (await adapter.listEntries(roomA)).entries[0]!.cursor;

    // Constructed, awaiting nothing. An `async function*` implementation would
    // defer this to the first `next()` and fail the suite's U6/U7.
    expect(() => adapter.subscribeRoom(roomB, foreign)).toThrow(StaleCommunityCursorError);

    const otherCommunity = new FakeCommunityAdapter({
      community: 'B0000000000000000000000001' as CommunityRef,
    });
    await otherCommunity.connect();
    const otherRoom = otherCommunity.seedRoom({ entries: 1 });
    const otherCursor = (await otherCommunity.listEntries(otherRoom)).entries[0]!.cursor;
    expect(() => adapter.subscribeRoom(roomA, otherCursor)).toThrow(StaleCommunityCursorError);

    const supersededEpoch = new FakeCommunityAdapter({ epoch: 'e2' });
    await supersededEpoch.connect();
    const epochRoom = supersededEpoch.seedRoom({ entries: 1 });
    expect(
      () => adapter.subscribeRoom(roomA, `local|${roomA}|e2|1` as CommunityCursor),
      'a cursor from a superseded epoch is rejected, not bounded'
    ).toThrow(StaleCommunityCursorError);
    expect(epochRoom).toBeTruthy();
  });

  it('refuses every gated method whose capability is off, and refuses nothing else', async () => {
    const off = new FakeCommunityAdapter({
      capabilities: {
        canPost: false,
        roomAdmin: false,
        invite: 'none',
        agentAdmission: 'none',
        readCursor: 'none',
        responseMode: false,
        signals: 'none',
      },
    });
    await off.connect();
    const roomId = off.seedRoom({ entries: 2 });

    await expect(off.post(roomId, { text: 'x' })).rejects.toBeInstanceOf(CommunityUnsupportedError);
    await expect(off.createRoom({ title: 'x' })).rejects.toBeInstanceOf(CommunityUnsupportedError);
    await expect(off.createInvite({})).rejects.toBeInstanceOf(CommunityUnsupportedError);
    await expect(off.admitAgent({ agentId: 'a', displayName: 'A' })).rejects.toBeInstanceOf(
      CommunityUnsupportedError
    );
    await expect(off.getReadCursor(roomId)).rejects.toBeInstanceOf(CommunityUnsupportedError);
    await expect(off.setResponseMode(roomId, 'member-self', 'silent')).rejects.toBeInstanceOf(
      CommunityUnsupportedError
    );
    await expect(off.publishSignal(roomId, 'typing')).rejects.toBeInstanceOf(
      CommunityUnsupportedError
    );

    // Reading is never gated: a read-only backend is still a backend.
    await expect(off.listRooms()).resolves.toHaveLength(1);
    await expect(off.listMembers(roomId)).resolves.not.toHaveLength(0);
  });

  it('a community-scoped invite refuses a room, rather than widening it', async () => {
    const adapter = new FakeCommunityAdapter({ capabilities: { invite: 'community' } });
    await adapter.connect();
    const roomId = adapter.seedRoom({ entries: 1 });

    await expect(adapter.createInvite({})).resolves.toMatchObject({ roomId: null });
    await expect(adapter.createInvite({ roomId })).rejects.toBeInstanceOf(
      CommunityUnsupportedError
    );

    // And it says what is actually wrong. `invite` is ON here, just narrower
    // than asked for, so "capability 'invite' is off" would send a reader
    // looking for a flag that is already set.
    const refusal = await adapter.createInvite({ roomId }).catch((err: unknown) => err);
    expect((refusal as Error).message).not.toContain("capability 'invite' is off");
    expect((refusal as CommunityUnsupportedError).reason).toBeTruthy();
  });

  it('an agent is its own member, never its owner, and never administers', async () => {
    const adapter = new FakeCommunityAdapter();
    const { identity } = await adapter.connect();
    const agent = await adapter.admitAgent({ agentId: 'a1', displayName: 'Agent' });

    expect(agent.memberId).not.toBe(identity!.memberId);
    expect(agent.ownerMemberId).toBe(identity!.memberId);
    const caps = adapter.getCapabilities();
    expect(caps.roles.values.find((r) => r.id === agent.role)?.administers).toBe(false);

    // Removing the human removes their agents, re-evaluated on use.
    adapter.removeCommunityMember(identity!.memberId);
    await expect(adapter.admitAgent({ agentId: 'a1', displayName: 'Agent' })).rejects.toThrow();
  });

  it('an unservable room ends with a terminal room_closed carrying its arranged reason', async () => {
    const adapter = new FakeCommunityAdapter();
    await adapter.connect();
    const roomId = adapter.seedRoom({ entries: 1 });
    const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();

    const snapshot = await iterator.next();
    expect(snapshot.value.type).toBe('snapshot');

    adapter.evictRoom(roomId, 'access-revoked');
    const closed = await iterator.next();
    expect(closed.value).toEqual({ type: 'room_closed', reason: 'access-revoked' });
    // A member who lost access is not told the room was put away.
    expect(closed.value.reason).not.toBe('archived');
    expect((await iterator.next()).done).toBe(true);
  });

  it('a client-opaque read cursor round-trips while every unread count stays null', async () => {
    const adapter = new FakeCommunityAdapter({ capabilities: { readCursor: 'client-opaque' } });
    await adapter.connect();
    const roomId = adapter.seedRoom({ entries: 3 });
    const cursor = (await adapter.listEntries(roomId)).entries.at(-1)!.cursor;

    await adapter.setReadCursor(roomId, cursor);
    await expect(adapter.getReadCursor(roomId)).resolves.toBe(cursor);
    for (const room of await adapter.listRooms()) {
      // null, never 0: a silent room and a room whose unread cannot be computed
      // are different states.
      expect(room.unreadCount).toBeNull();
    }
  });
});
