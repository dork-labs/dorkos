import {
  REF,
  ROOM_ID,
  VERIFIED_AGENT_ACCESS,
  entry,
  live,
  testRoom,
  snapshot,
} from './fixtures.js';
import type { CommunityEntry, CommunityRoom } from '@dorkos/shared/community-adapter';
import { describe, expect, it } from 'vitest';
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
  it('imports a captured replay without turns, then dispatches one fresh human mention without a browser', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: agent.id,
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === agent.id ? agent.id : null)
    );
    let releaseLive: (() => void) | undefined;
    const fresh = new Promise<void>((resolve) => {
      releaseLive = resolve;
    });
    const room: CommunityRoom = {
      community: REF,
      roomId: ROOM_ID,
      kind: 'channel',
      title: 'General',
      slug: null,
      topic: null,
      archived: false,
      createdAt: '2026-09-16T00:00:00.000Z',
      lastActivityAt: '2026-09-16T00:00:00.000Z',
      unreadCount: 0,
    };
    const adapter: RemoteRoomSubscriptionAdapter = {
      async listRooms() {
        return [room];
      },
      subscribeNativeRoom(): AsyncIterable<RemoteNativeRoomEvent> {
        return (async function* () {
          yield {
            type: 'snapshot' as const,
            room,
            entries: [entry(1)],
            capturedSeq: 1,
            cursor: 'cursor-1' as CommunityEntry['cursor'],
          };
          yield { type: 'replay_complete' as const, capturedSeq: 1 };
          await fresh;
          yield { type: 'entry' as const, entry: entry(2) };
        })();
      },
    };
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
      adapters: () => adapter,
      resolveLocalAgentAuthor: (localAgentId) => (localAgentId === agent.id ? agent.id : null),
      isRoomJoined: () => true,
      toLiveEntry: (value) => live(value, Number(value.id.slice('entry-'.length))),
      retryMs: 1,
    });

    runtime.start();
    await settleUntil(
      () => runtime.observation(REF, ROOM_ID, harness.human)?.replayComplete === true,
      'the captured native replay is imported'
    );
    expect(runtime.observation(REF, ROOM_ID, harness.human)).toMatchObject({
      snapshotComplete: true,
      replayComplete: true,
      dispatchesSinceBoot: 0,
    });
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(0);

    releaseLive!();
    await settleUntil(
      () => runtime.observation(REF, ROOM_ID, harness.human)?.dispatchesSinceBoot === 1,
      'the fresh native mention is dispatched'
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);
    runtime.stop();
  });

  it('authorizes each enrolled agent from that agent directory before dispatch', async () => {
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
      localAgentId: ana.id,
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    enrollments.activate({
      communityRef: REF,
      localAgentId: bob.id,
      remoteMemberId: 'remote-bob',
      ownerAuthorId: harness.human,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === ana.id || localAgentId === bob.id ? localAgentId : null)
    );
    const room = testRoom();
    const streamMembers: string[] = [];
    const adapter: RemoteRoomSubscriptionAdapter = {
      async listRooms(context) {
        return context?.actingMemberId === 'remote-ana' ? [room] : [];
      },
      subscribeNativeRoom(
        _roomId,
        _cursor,
        _signal,
        context
      ): AsyncIterable<RemoteNativeRoomEvent> {
        streamMembers.push(context?.actingMemberId ?? 'missing');
        return (async function* () {
          yield snapshot(room, [entry(1)], 1);
          yield { type: 'replay_complete' as const, capturedSeq: 1 };
          // Bob is actively enrolled but is not a member of this remote room.
          yield { type: 'entry' as const, entry: entry(2, ['remote-bob']) };
          yield { type: 'entry' as const, entry: entry(3, ['remote-ana']) };
        })();
      },
    };
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
      adapters: () => adapter,
      resolveLocalAgentAuthor: (localAgentId) =>
        localAgentId === ana.id || localAgentId === bob.id ? localAgentId : null,
      isRoomJoined: () => true,
      toLiveEntry: (value) => live(value, Number(value.id.slice('entry-'.length))),
      retryMs: 1,
    });

    runtime.start();
    await settleUntil(
      () => runtime.observation(REF, ROOM_ID, harness.human)?.dispatchesSinceBoot === 1,
      'only the room-joined agent is dispatched'
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);
    expect(harness.runner.turns[0]?.authorId).toBe(ana.id);
    expect(streamMembers).toEqual(['remote-ana']);
    runtime.stop();
  });

  it('keeps an agent’s direct message and wakes it on every post there, mention or not (DOR-2955)', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    });
    const ana = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: ana.id,
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    const bridge = new RemoteRoomSubscriptionBridge(mirrors, harness.service, enrollments, (id) =>
      id === ana.id ? id : null
    );
    const dm: CommunityRoom = { ...testRoom(), kind: 'dm', title: 'Direct message with Bo' };
    const adapter: RemoteRoomSubscriptionAdapter = {
      listRooms: async () => [],
      listDirectMessageRooms: async (context) =>
        context.actingMemberId === 'remote-ana' ? [dm] : [],
      subscribeNativeRoom(): AsyncIterable<RemoteNativeRoomEvent> {
        return (async function* () {
          yield snapshot(dm, [entry(1, [])], 1);
          yield { type: 'replay_complete' as const, capturedSeq: 1 };
          yield { type: 'entry' as const, entry: entry(2, []) };
        })();
      },
    };
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
      adapters: () => adapter,
      resolveLocalAgentAuthor: (id) => (id === ana.id ? id : null),
      isRoomJoined: () => true,
      toLiveEntry: (value) => live(value, Number(value.id.slice('entry-'.length))),
      retryMs: 1,
    });

    runtime.start();
    await settleUntil(
      () => runtime.observation(REF, ROOM_ID, harness.human)?.dispatchesSinceBoot === 1,
      'the direct message wakes its agent without a mention'
    );
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);
    expect(harness.runner.turns[0]?.authorId).toBe(ana.id);
    expect(harness.runner.turns[0]?.teammate).toBe(true);
    runtime.stop();
  });

  it('revokes a persisted mirror and aborts its agent stream when the fresh agent directory removes the room', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
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
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'mesh-manifest-ana' ? agent.id : null)
    );
    const room = testRoom();
    let joined = true;
    let aborted = false;
    const adapter: RemoteRoomSubscriptionAdapter = {
      async listRooms() {
        return joined ? [room] : [];
      },
      subscribeNativeRoom(_roomId, _cursor, signal, context): AsyncIterable<RemoteNativeRoomEvent> {
        expect(context).toEqual({ actingMemberId: 'remote-ana' });
        return (async function* () {
          yield snapshot(room, [entry(1)], 1);
          yield { type: 'replay_complete' as const, capturedSeq: 1 };
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
          });
        })();
      },
    };
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
      adapters: () => adapter,
      resolveLocalAgentAuthor: (localAgentId) =>
        localAgentId === 'mesh-manifest-ana' ? agent.id : null,
      isRoomJoined: () => true,
      toLiveEntry: (value) => live(value, Number(value.id.slice('entry-'.length))),
      retryMs: 1,
    });

    runtime.start();
    await settleUntil(
      () => runtime.observation(REF, ROOM_ID, harness.human)?.replayComplete === true,
      'the enrolled agent stream is ready'
    );
    const localRoomId = mirrors.localRoomIdForOwner(REF, ROOM_ID, harness.human);
    expect(localRoomId).not.toBeNull();
    expect(mirrors.canRead(localRoomId!, agent.id)).toBe(true);

    joined = false;
    runtime.refreshSubscriptions();
    await settleUntil(
      () => mirrors.canRead(localRoomId!, agent.id) === false && aborted,
      'the removed agent loses its persisted grant and stream'
    );
    expect(mirrors.isActivelyAuthorized(localRoomId!, harness.human)).toBe(false);
    runtime.stop();
  });
});
