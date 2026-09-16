/** @vitest-environment node */
import type { CommunityEntry, CommunityRef, CommunityRoom } from '@dorkos/shared/community-adapter';
import { describe, expect, it } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
} from '../../../rooms/__tests__/room-test-harness.js';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import { CommunityOutboxStore } from '../community-outbox-store.js';
import { RemoteMirrorStore } from '../mirror-store.js';
import {
  RemoteRoomSubscriptionBridge,
  type RemoteLiveEntry,
} from '../remote-room-subscription-bridge.js';
import {
  RemoteRoomSubscriptionRuntime,
  type RemoteRoomSubscriptionAdapter,
} from '../remote-room-subscription-runtime.js';
import type { RemoteNativeRoomEvent } from '../remote-community-adapter.js';

const REF = 'remote_owner_a' as CommunityRef;
const ROOM_ID = 'room-a';

function entry(seq: number, mentions: string[] = ['remote-ana']): CommunityEntry {
  return {
    community: REF,
    roomId: ROOM_ID,
    id: `entry-${seq}`,
    authorId: 'remote-human',
    text: `message ${seq}`,
    mentions,
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `cursor-${seq}` as CommunityEntry['cursor'],
    createdAt: '2026-09-16T01:00:00.000Z',
  };
}

function live(value: CommunityEntry, seq: number): RemoteLiveEntry {
  return {
    entry: value,
    remoteSeq: seq,
    author: { memberId: 'remote-human', displayName: 'Remote human', kind: 'human' },
    serverCreatedAt: value.createdAt,
  };
}

describe('RemoteRoomSubscriptionRuntime', () => {
  it('preserves persisted grants and pending work until Mesh becomes authoritative after restart', async () => {
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
    const outbox = new CommunityOutboxStore(harness.db);
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      enrollments,
      (id) => (id === 'mesh-manifest-ana' ? agent.id : null),
      undefined,
      outbox
    );
    bridge.authorizeRoom({
      communityRef: REF,
      remoteRoomId: ROOM_ID,
      title: 'General',
      topic: null,
      ownerAuthorId: harness.human,
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
      authorizedAt: '2026-09-16T00:00:00.000Z',
    });
    harness.db.transaction((tx) =>
      outbox.enqueue(
        {
          id: 'pending-restart',
          communityRef: REF,
          remoteRoomId: ROOM_ID,
          ownerAuthorId: harness.human,
          localEntryId: 'local-entry',
          localParentEntryId: null,
          localAgentId: 'mesh-manifest-ana',
          attachmentIds: '[]',
          idempotencyKey: 'restart-key',
          state: 'pending',
          createdAt: '2026-09-16T00:00:00.000Z',
          expiresAt: '2026-09-16T00:05:00.000Z',
          remoteEntryId: null,
          failure: null,
          attempts: 0,
          nextAttemptAt: '2026-09-16T00:00:00.000Z',
        },
        tx
      )
    );
    let meshReady = false;
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      adapters: () => ({
        listRooms: async () => [],
        subscribeNativeRoom: () => (async function* () {})(),
      }),
      resolveLocalAgentAuthor: (id) => (id === 'mesh-manifest-ana' ? agent.id : null),
      isReady: () => meshReady,
      retryMs: 1,
    });
    const localRoomId = mirrors.localRoomIdForOwner(REF, ROOM_ID, harness.human)!;
    runtime.start();
    expect(mirrors.isActivelyAuthorized(localRoomId, harness.human)).toBe(true);
    expect(outbox.isPending('pending-restart')).toBe(true);

    meshReady = true;
    runtime.start();
    await settleUntil(
      () => !outbox.isPending('pending-restart'),
      'the first authoritative refresh'
    );
    expect(mirrors.isActivelyAuthorized(localRoomId, harness.human)).toBe(false);
    runtime.stop();
  });

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

  it('replaces the replay observation for every reconnect generation', async () => {
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
    let releaseFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond: (() => void) | undefined;
    const secondDone = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let streams = 0;
    const room = testRoom();
    const adapter: RemoteRoomSubscriptionAdapter = {
      async listRooms() {
        return [room];
      },
      subscribeNativeRoom(): AsyncIterable<RemoteNativeRoomEvent> {
        streams += 1;
        if (streams === 1) {
          return (async function* () {
            yield snapshot(room, [entry(1)], 1);
            yield { type: 'replay_complete' as const, capturedSeq: 1 };
            await firstDone;
          })();
        }
        return (async function* () {
          yield snapshot(room, [entry(1)], 1);
          await secondDone;
          yield { type: 'replay_complete' as const, capturedSeq: 1 };
        })();
      },
    };
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      adapters: () => adapter,
      resolveLocalAgentAuthor: (localAgentId) => (localAgentId === agent.id ? agent.id : null),
      isRoomJoined: () => true,
      toLiveEntry: (value) => live(value, Number(value.id.slice('entry-'.length))),
      retryMs: 1,
    });

    runtime.start();
    await settleUntil(
      () => runtime.observation(REF, ROOM_ID, harness.human)?.generation === 1,
      'the initial subscription begins'
    );
    expect(runtime.observation(REF, ROOM_ID, harness.human)).toMatchObject({
      snapshotComplete: true,
      replayComplete: true,
    });
    releaseFirst!();
    await settleUntil(
      () => runtime.observation(REF, ROOM_ID, harness.human)?.generation === 2,
      'the reconnect begins a new replay boundary'
    );
    expect(runtime.observation(REF, ROOM_ID, harness.human)).toMatchObject({
      snapshotComplete: true,
      replayComplete: false,
      dispatchesSinceBoot: 0,
    });
    releaseSecond!();
    runtime.stop();
  });
});

function testRoom(): CommunityRoom {
  return {
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
}

function snapshot(
  room: CommunityRoom,
  entries: CommunityEntry[],
  capturedSeq: number
): Extract<RemoteNativeRoomEvent, { type: 'snapshot' }> {
  return {
    type: 'snapshot',
    room,
    entries,
    capturedSeq,
    cursor: `cursor-${capturedSeq}` as CommunityEntry['cursor'],
  };
}
