import { REF_A, nativeEntry, wired, roomInput } from './fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { authorOrigin } from '../../../../rooms/author-registry.js';
import {
  agentLookupFor,
  gatedRunner,
  settleUntil,
} from '../../../../rooms/__tests__/room-test-harness.js';
import { CommunityAgentEnrollmentStore } from '../../agent-enrollment-store.js';
import { RemoteRoomSubscriptionBridge } from '../../remote-room-subscription-bridge.js';

describe('RemoteMirrorStore', () => {
  it('does not restore a revoked mirror when a delayed snapshot arrives before a live mention', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'revoked-general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const local = mirrors.ensureRoom(room);
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null)
    );
    mirrors.revoke(REF_A, harness.human);
    bridge.importSnapshot(room, [
      {
        ...nativeEntry(REF_A, 'revoked-general', 1),
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
    ]);
    const live = nativeEntry(REF_A, 'revoked-general', 2);
    live.entry = { ...live.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      {
        ...live,
        author: { ...live.author, kind: 'human' },
        serverCreatedAt: '2026-09-16T01:00:00.000Z',
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
    expect(mirrors.isActivelyAuthorized(local.id, harness.human)).toBe(false);
  });

  it('revokes a local enrollment before stopping its held external turn', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const runner = gatedRunner({ interruptedTurnStillAnswers: true });
    const { harness, mirrors } = wired(agents, { runner });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null)
    );
    const incoming = nativeEntry(REF_A, 'general', 1);
    incoming.entry = { ...incoming.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      {
        ...incoming,
        author: { ...incoming.author, kind: 'human' },
        serverCreatedAt: new Date().toISOString(),
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await settleUntil(() => runner.holdsFor(agent.id) === 1, 'external turn to be held');
    const imported = harness.store.listEntriesAfter(mirrors.ensureRoom(room).id, 0)[0];
    const importedOrigin = authorOrigin(harness.authors.getById(imported!.authorId)!.naturalKey);
    expect(importedOrigin).not.toBe('local');

    // A fresh process owns no in-memory room subscription map. Revocation still
    // stops the held turn by reading the persisted mirror rows first.
    const abortForAgent = vi.fn();
    const restarted = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null),
      undefined,
      undefined,
      { abortForRoom: vi.fn(), abortForAgent }
    );
    await restarted.revokeEnrollment(REF_A, 'local-ana', harness.human);
    await harness.service.triggersIdle();
    expect(enrollments.findRemoteMember(REF_A, 'local-ana', harness.human)).toBeNull();
    expect(abortForAgent).toHaveBeenCalledWith(REF_A, 'local-ana', harness.human);
    expect(runner.interrupted).toHaveLength(1);
    expect(harness.service.listHolds()).toHaveLength(0);
  });

  // Purpose (DOR-2339): a revoked mirror is unreadable to its owner too, so the ordinary Stop
  // refused it as missing and the agent's turn there kept running. It fails if the revocation
  // throws, or if the turn is not interrupted.
  it('stops a turn running in a room the directory no longer lists, without an error', async () => {
    const { harness, mirrors, runner, bridge, localRoomId } = await heldTurnInMirror();

    await expect(
      bridge.revokeAbsentRooms(REF_A, harness.human, new Set())
    ).resolves.toBeUndefined();
    await harness.service.triggersIdle();

    expect(runner.interrupted).toHaveLength(1);
    expect(harness.service.listActiveClaims()).toEqual([]);
    expect(mirrors.localRoomIdForOwner(REF_A, 'general', harness.human)).toBeNull();
    expect(harness.store.getRoom(localRoomId)).toBeNull();
  });

  /**
   * One owner's mirror with Ana enrolled and a turn of hers held in it: the scene every
   * revocation test below starts from.
   */
  async function heldTurnInMirror() {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const runner = gatedRunner();
    const { harness, mirrors } = wired(agents, { runner });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null)
    );
    const incoming = nativeEntry(REF_A, 'general', 1);
    incoming.entry = { ...incoming.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      {
        ...incoming,
        author: { ...incoming.author, kind: 'human' },
        serverCreatedAt: new Date().toISOString(),
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await settleUntil(() => runner.holdsFor(agent.id) === 1, 'the mirrored turn to be held');
    const localRoomId = mirrors.localRoomIdForOwner(REF_A, 'general', harness.human)!;
    return { harness, mirrors, runner, agent, bridge, localRoomId };
  }

  // Purpose (DOR-2339): the same for a whole connection the Community rejected.
  it('stops a turn running in a mirror when its whole connection is revoked', async () => {
    const { harness, runner, bridge, localRoomId } = await heldTurnInMirror();

    await expect(bridge.revokeConnection(REF_A, harness.human)).resolves.toBeUndefined();
    await harness.service.triggersIdle();

    expect(runner.interrupted).toHaveLength(1);
    expect(harness.service.listActiveClaims()).toEqual([]);
    expect(harness.store.getRoom(localRoomId)).toBeNull();
  });

  // Purpose (DOR-2339 review): membership is per room, so an agent's owner can hold readable
  // mirrors it never joined. Revoking its enrollment must skip those rather than refuse the
  // whole revocation, or its memberships are never removed and the turn it does have keeps
  // running. It fails if one unjoined mirror makes the revocation reject.
  it('revokes an enrollment even when the owner has a mirror the agent never joined', async () => {
    const { harness, mirrors, runner, agent, bridge } = await heldTurnInMirror();
    mirrors.ensureRoom(roomInput(REF_A, 'other', harness.human));

    await expect(
      bridge.revokeEnrollment(REF_A, 'local-ana', harness.human)
    ).resolves.toBeUndefined();
    await harness.service.triggersIdle();

    expect(runner.interrupted).toHaveLength(1);
    expect(harness.service.listActiveClaims()).toEqual([]);
    const general = mirrors.localRoomIdForOwner(REF_A, 'general', harness.human)!;
    expect(harness.store.getMember(general, agent.id)).toBeNull();
  });

  // Purpose (DOR-2339 guard): the revocation's stop skips the visibility check, so it must not
  // become a way round it. A caller who cannot see a room still cannot stop a turn in it: the
  // ordinary Stop refuses a revoked mirror, and the revocation's stop refuses any room that is
  // not a revoked mirror of the caller's own connection. It fails if either widens.
  it('never lets a caller stop a turn in a room they cannot see', async () => {
    const { harness, mirrors, runner, agent, localRoomId } = await heldTurnInMirror();

    // Still readable: the revocation's stop refuses it, and the ordinary Stop is the way in.
    await expect(
      harness.service.haltAgentInRevokedMirror(localRoomId, agent.id, harness.human)
    ).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    // An ordinary local room is never a revoked mirror.
    const local = harness.service.createRoom(
      { kind: 'channel', slug: 'local', title: '#local', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    await expect(
      harness.service.haltAgentInRevokedMirror(local.id, agent.id, harness.human)
    ).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });

    mirrors.revoke(REF_A, harness.human);
    // Revoked: nobody sees it, so the ordinary Stop refuses everyone, its owner included.
    await expect(
      harness.service.haltAgent(localRoomId, agent.id, harness.human)
    ).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    // And the revocation's stop answers only to the mirror's own owner.
    const stranger = harness.authors.human('someone-else');
    await expect(
      harness.service.haltAgentInRevokedMirror(localRoomId, agent.id, stranger.id)
    ).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    await expect(
      harness.service.haltAgentInRevokedMirror(localRoomId, agent.id, agent.id)
    ).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    expect(runner.interrupted).toEqual([]);
    expect(runner.holdsFor(agent.id)).toBe(1);

    await expect(
      harness.service.haltAgentInRevokedMirror(localRoomId, agent.id, harness.human)
    ).resolves.toBe(1);
    await harness.service.triggersIdle();
    expect(runner.interrupted).toHaveLength(1);
  });

  it('returns the real RoomService count when stopping one qualified mirrored agent', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const runner = gatedRunner();
    const { harness, mirrors } = wired(agents, { runner });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = {
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    };
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null)
    );
    const incoming = nativeEntry(REF_A, 'general', 1);
    incoming.entry = { ...incoming.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      {
        ...incoming,
        author: { ...incoming.author, kind: 'human' },
        serverCreatedAt: new Date().toISOString(),
      },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await settleUntil(() => runner.holdsFor(agent.id) === 1, 'the qualified external turn to hold');

    // This is the numeric RoomService receipt that the route must preserve.
    await expect(bridge.haltRoomAgent(REF_A, 'general', 'local-ana', harness.human)).resolves.toBe(
      1
    );
    await harness.service.triggersIdle();
    expect(runner.interrupted).toHaveLength(1);
  });
});
