import {
  REF,
  ROOM_ID,
  VERIFIED_AGENT_ACCESS,
  entry,
  live,
  testRoom,
  snapshot,
} from './fixtures.js';
import type { CommunityRoom } from '@dorkos/shared/community-adapter';
import { describe, expect, it, vi } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
} from '../../../../rooms/__tests__/room-test-harness.js';
import { CommunityAgentEnrollmentStore } from '../../agent-enrollment-store.js';
import { RemoteMirrorStore } from '../../mirror-store.js';
import { RemoteRoomSubscriptionBridge } from '../../remote-room-subscription-bridge.js';
import {
  RemoteRoomSubscriptionRuntime,
  type RemoteRoomSubscriptionAdapter,
} from '../../remote-room-subscription-runtime.js';
import type { RemoteNativeRoomEvent } from '../../remote-community-adapter.js';

describe('RemoteRoomSubscriptionRuntime', () => {
  it('does not restore a left room from a directory read that started before removal', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    });
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: 'mesh-manifest-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'mesh-manifest-ana' ? ana.id : null)
    );
    const room = testRoom();
    bridge.authorizeRoom({
      communityRef: REF,
      remoteRoomId: ROOM_ID,
      title: room.title,
      topic: room.topic,
      ownerAuthorId: harness.human,
      accessors: [{ authorId: ana.id, responseMode: 'always' }],
      authorizedAt: '2026-09-16T01:00:00.000Z',
    });
    const localRoomId = mirrors.localRoomIdForOwner(REF, ROOM_ID, harness.human);
    expect(localRoomId).not.toBeNull();

    let releaseDirectory!: (rooms: CommunityRoom[]) => void;
    const firstDirectory = new Promise<CommunityRoom[]>((resolve) => {
      releaseDirectory = resolve;
    });
    let directoryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      directoryStarted = resolve;
    });
    let calls = 0;
    const subscribeNativeRoom = vi.fn();
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
      adapters: () => ({
        listRooms: async () => {
          calls += 1;
          if (calls === 1) {
            directoryStarted();
            return firstDirectory;
          }
          return [];
        },
        subscribeNativeRoom,
      }),
      resolveLocalAgentAuthor: (localAgentId) =>
        localAgentId === 'mesh-manifest-ana' ? ana.id : null,
      isRoomJoined: () => true,
      retryMs: 1,
    });

    runtime.start();
    await started;
    await runtime.leaveRoom(REF, ROOM_ID, 'mesh-manifest-ana', harness.human);
    releaseDirectory([room]);
    await settleUntil(
      () => calls >= 2 && mirrors.canRead(localRoomId!, ana.id) === false,
      'the stale directory is discarded before it can restore the left room'
    );
    expect(subscribeNativeRoom).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('fences only the departed agent-room pair and preserves other qualified grants', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({
        '/agents/ana': { name: 'Ana', responseMode: 'always' },
        '/agents/bob': { name: 'Bob', responseMode: 'always' },
      }),
    });
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const bob = harness.authors.resolveAgent('/agents/bob', 'Bob');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: 'mesh-manifest-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    enrollments.activate({
      communityRef: REF,
      localAgentId: 'mesh-manifest-bob',
      remoteMemberId: 'remote-bob',
      ownerAuthorId: harness.human,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) =>
        localAgentId === 'mesh-manifest-ana'
          ? ana.id
          : localAgentId === 'mesh-manifest-bob'
            ? bob.id
            : null
    );
    const room = testRoom();
    const secondRoom = { ...room, roomId: 'room-b', title: 'Build' };
    const primary = {
      communityRef: REF,
      remoteRoomId: ROOM_ID,
      title: room.title,
      topic: room.topic,
      ownerAuthorId: harness.human,
      accessors: [
        { authorId: ana.id, responseMode: 'always' as const },
        { authorId: bob.id, responseMode: 'always' as const },
      ],
      authorizedAt: '2026-09-16T01:00:00.000Z',
    };
    const secondary = {
      communityRef: REF,
      remoteRoomId: secondRoom.roomId,
      title: secondRoom.title,
      topic: secondRoom.topic,
      ownerAuthorId: harness.human,
      accessors: [{ authorId: ana.id, responseMode: 'always' as const }],
      authorizedAt: '2026-09-16T01:00:00.000Z',
    };
    bridge.authorizeRoom(primary);
    bridge.authorizeRoom(secondary);
    const localPrimary = mirrors.localRoomIdForOwner(REF, ROOM_ID, harness.human);
    const localSecondary = mirrors.localRoomIdForOwner(REF, secondRoom.roomId, harness.human);
    expect(localPrimary).not.toBeNull();
    expect(localSecondary).not.toBeNull();

    await bridge.leaveRoom(REF, ROOM_ID, 'mesh-manifest-ana', harness.human);

    expect(mirrors.canRead(localPrimary!, ana.id)).toBe(false);
    expect(mirrors.canRead(localPrimary!, bob.id)).toBe(true);
    expect(mirrors.canRead(localSecondary!, ana.id)).toBe(true);

    bridge.importLive(primary, live(entry(2, ['remote-ana', 'remote-bob']), 2), {
      reconnect: false,
      wasActiveBeforeDisconnect: false,
      readOnly: false,
    });
    bridge.importLive(
      secondary,
      live({ ...entry(3, ['remote-ana']), roomId: secondRoom.roomId }, 3),
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toEqual([
      expect.objectContaining({ authorId: bob.id }),
      expect.objectContaining({ authorId: ana.id }),
    ]);
  });

  it('revokes every derived local authority before a rejected owner grant returns', async () => {
    // Rooms read mirror access from the same store the bridge writes, as production wires it,
    // so the revoked mirror is as unreadable here as it is there (DOR-2339).
    const state: { mirrors?: RemoteMirrorStore } = {};
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
      mirrorAccess: {
        canRead: (roomId, authorId) => state.mirrors?.canRead(roomId, authorId) ?? null,
        hasMirrors: () => state.mirrors?.hasMirrors() ?? false,
        isRevokedMirrorOf: (roomId, ownerAuthorId) =>
          state.mirrors?.isRevokedMirrorOf(roomId, ownerAuthorId) ?? false,
      },
    });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: 'mesh-manifest-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    state.mirrors = mirrors;
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      () => agent.id
    );
    const room = testRoom();
    let streamClosed = false;
    const adapter: RemoteRoomSubscriptionAdapter = {
      async listRooms() {
        return [room];
      },
      subscribeNativeRoom(_roomId, _cursor, signal): AsyncIterable<RemoteNativeRoomEvent> {
        return (async function* () {
          try {
            yield snapshot(room, [entry(1)], 1);
            yield { type: 'replay_complete' as const, capturedSeq: 1 };
            await new Promise<void>((resolve) => {
              if (signal?.aborted) resolve();
              else signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          } finally {
            streamClosed = true;
          }
        })();
      },
    };
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
      adapters: () => adapter,
      resolveLocalAgentAuthor: () => agent.id,
      isRoomJoined: () => true,
      toLiveEntry: (value) => live(value, Number(value.id.slice('entry-'.length))),
      retryMs: 1,
    });

    runtime.start();
    await settleUntil(
      () => runtime.observation(REF, ROOM_ID, harness.human)?.replayComplete === true,
      'the connection stream is ready'
    );
    const localRoomId = mirrors.localRoomIdForOwner(REF, ROOM_ID, harness.human);
    expect(localRoomId).not.toBeNull();

    await runtime.revokeConnection(REF, harness.human);
    await settleUntil(() => streamClosed, 'the rejected connection stream closes');

    expect(enrollments.activeForOwner(REF, harness.human)).toEqual([]);
    expect(mirrors.canRead(localRoomId!, agent.id)).toBe(false);
    expect(mirrors.cachedEntriesForOwner(REF, ROOM_ID, harness.human, { limit: 10 })).toEqual([]);
    runtime.stop();
  });

  it('fences an ejected agent before a parked native stream can dispatch its next mention', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({
        '/agents/ana': { name: 'Ana', responseMode: 'always' },
        '/agents/bob': { name: 'Bob', responseMode: 'always' },
      }),
    });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const bob = harness.authors.resolveAgent('/agents/bob', 'Bob');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: 'mesh-manifest-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    enrollments.activate({
      communityRef: REF,
      localAgentId: 'mesh-manifest-bob',
      remoteMemberId: 'remote-bob',
      ownerAuthorId: harness.human,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) =>
        localAgentId === 'mesh-manifest-ana'
          ? agent.id
          : localAgentId === 'mesh-manifest-bob'
            ? bob.id
            : null
    );
    const room = testRoom();
    let releaseEntry!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseEntry = resolve;
    });
    let staleFrameDelivered = false;
    const adapter: RemoteRoomSubscriptionAdapter = {
      async listRooms() {
        return [room];
      },
      subscribeNativeRoom(): AsyncIterable<RemoteNativeRoomEvent> {
        return (async function* () {
          yield snapshot(room, [entry(1)], 1);
          yield { type: 'replay_complete' as const, capturedSeq: 1 };
          await parked;
          staleFrameDelivered = true;
          yield { type: 'entry' as const, entry: entry(2) };
        })();
      },
    };
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
      adapters: () => adapter,
      resolveLocalAgentAuthor: (localAgentId) =>
        localAgentId === 'mesh-manifest-ana'
          ? agent.id
          : localAgentId === 'mesh-manifest-bob'
            ? bob.id
            : null,
      isRoomJoined: () => true,
      toLiveEntry: (value) => live(value, Number(value.id.slice('entry-'.length))),
      retryMs: 1,
    });

    runtime.start();
    await settleUntil(
      () => runtime.observation(REF, ROOM_ID, harness.human)?.replayComplete === true,
      'the ejected agent stream is ready'
    );
    const localRoomId = mirrors.localRoomIdForOwner(REF, ROOM_ID, harness.human);
    expect(localRoomId).not.toBeNull();
    bridge.authorizeRoom({
      communityRef: REF,
      remoteRoomId: ROOM_ID,
      title: room.title,
      topic: room.topic,
      ownerAuthorId: harness.human,
      accessors: [
        { authorId: agent.id, responseMode: 'always' },
        { authorId: bob.id, responseMode: 'always' },
      ],
      authorizedAt: '2026-09-16T01:00:00.000Z',
    });

    let releaseHalt!: () => void;
    const halted = new Promise<void>((resolve) => {
      releaseHalt = resolve;
    });
    let haltStarted!: () => void;
    const haltHasStarted = new Promise<void>((resolve) => {
      haltStarted = resolve;
    });
    const haltAgent = harness.service.haltAgent.bind(harness.service);
    vi.spyOn(harness.service, 'haltAgent').mockImplementation(async (...args) => {
      haltStarted();
      await halted;
      return haltAgent(...args);
    });

    const revoking = runtime.revokeEnrollment(REF, 'mesh-manifest-ana', harness.human);
    await haltHasStarted;
    releaseEntry();
    await settleUntil(() => staleFrameDelivered, 'the parked stale native frame is imported');
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toEqual([]);

    releaseHalt();
    await revoking;

    expect(enrollments.findRemoteMember(REF, 'mesh-manifest-ana', harness.human)).toBeNull();
    expect(mirrors.canRead(localRoomId!, agent.id)).toBe(false);
    expect(harness.runner.turns).toEqual([]);
    expect(mirrors.canRead(localRoomId!, bob.id)).toBe(true);

    bridge.importLive(
      {
        communityRef: REF,
        remoteRoomId: ROOM_ID,
        title: room.title,
        topic: room.topic,
        ownerAuthorId: harness.human,
        accessors: [{ authorId: bob.id, responseMode: 'always' }],
        authorizedAt: '2026-09-16T01:00:00.000Z',
      },
      live(entry(3, ['remote-bob']), 3),
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toEqual([expect.objectContaining({ authorId: bob.id })]);
    runtime.stop();
  });
});
