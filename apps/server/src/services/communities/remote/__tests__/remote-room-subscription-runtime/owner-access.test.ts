import { REF, ROOM_ID, VERIFIED_AGENT_ACCESS, live, testRoom, snapshot } from './fixtures.js';
import type { CommunityEntry } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionAccess } from '@dorkos/shared/community-wire';
import { describe, expect, it, vi } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
} from '../../../../rooms/__tests__/room-test-harness.js';
import { CommunityAgentEnrollmentStore } from '../../agent-enrollment-store.js';
import { RemoteMirrorStore } from '../../mirror-store.js';
import { RemoteRoomSubscriptionBridge } from '../../remote-room-subscription-bridge.js';
import { RemoteRoomSubscriptionRuntime } from '../../remote-room-subscription-runtime.js';

describe('RemoteRoomSubscriptionRuntime', () => {
  it('does not reopen enrolled-agent remote work after restart while owner access is unavailable', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: agent.mintedForManifestId!,
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      new RemoteMirrorStore(harness.db, harness.store, harness.authors),
      harness.service,
      enrollments,
      () => agent.id
    );
    const adapters = vi.fn();
    const unavailableAccess = [
      null,
      {
        state: 'unverified' as const,
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: VERIFIED_AGENT_ACCESS.lastKnown,
      },
    ];

    for (const access of unavailableAccess) {
      const resolveConnectionAccess = vi.fn(async () => access);
      const runtime = new RemoteRoomSubscriptionRuntime({
        bridge,
        enrollments,
        resolveConnectionAccess,
        adapters,
        resolveLocalAgentAuthor: () => agent.id,
        retryMs: 1,
      });
      runtime.start();
      await vi.waitFor(() => expect(resolveConnectionAccess).toHaveBeenCalledOnce());
      runtime.stop();
    }

    expect(adapters).not.toHaveBeenCalled();
  });

  it('aborts an enrolled-agent stream when refreshed owner access becomes unverified', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: agent.mintedForManifestId!,
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      new RemoteMirrorStore(harness.db, harness.store, harness.authors),
      harness.service,
      enrollments,
      () => agent.id
    );
    const room = testRoom();
    let access: CommunityConnectionAccess = VERIFIED_AGENT_ACCESS;
    let streamAborted = false;
    const subscribeNativeRoom = vi.fn(
      (_roomId: string, _cursor?: CommunityEntry['cursor'], signal?: AbortSignal) =>
        (async function* () {
          yield snapshot(room, [], 0);
          yield { type: 'replay_complete' as const, capturedSeq: 0 };
          await new Promise<void>((resolve) =>
            signal?.addEventListener(
              'abort',
              () => {
                streamAborted = true;
                resolve();
              },
              { once: true }
            )
          );
        })()
    );
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess: async () => access,
      adapters: () => ({ listRooms: async () => [room], subscribeNativeRoom }),
      resolveLocalAgentAuthor: () => agent.id,
      isRoomJoined: () => true,
      retryMs: 60_000,
    });

    runtime.start();
    await vi.waitFor(() => expect(subscribeNativeRoom).toHaveBeenCalledOnce());
    access = {
      state: 'unverified',
      effective: { read: false, post: false, enrollAgent: false, stream: false },
      lastKnown: VERIFIED_AGENT_ACCESS.lastKnown,
    };
    runtime.refreshSubscriptions();
    await settleUntil(() => streamAborted, 'the unverified connection stream aborts');
    runtime.stop();
  });

  // DOR-2334. Purpose: a live stream the Community closes with `removed` asks the access route at
  // once, so a community being deleted is noticed (and its copies purged) without waiting for the
  // next reconcile or the stream's retry; any other close does not. It fails if the close is
  // ignored, as it was.
  it('asks the access route at once when the Community ends a stream’s access', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: agent.mintedForManifestId!,
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      new RemoteMirrorStore(harness.db, harness.store, harness.authors),
      harness.service,
      enrollments,
      () => agent.id
    );
    const room = testRoom();
    let closeReason: 'access-revoked' | 'archived' = 'archived';
    let closed = false;
    const subscribeNativeRoom = vi.fn(() =>
      (async function* () {
        yield snapshot(room, [], 0);
        yield { type: 'replay_complete' as const, capturedSeq: 0 };
        yield { type: 'room_closed' as const, reason: closeReason };
        closed = true;
      })()
    );
    const resolveConnectionAccess = vi.fn(async () => VERIFIED_AGENT_ACCESS);
    const runtime = new RemoteRoomSubscriptionRuntime({
      bridge,
      enrollments,
      resolveConnectionAccess,
      adapters: () => ({ listRooms: async () => [room], subscribeNativeRoom }),
      resolveLocalAgentAuthor: () => agent.id,
      isRoomJoined: () => true,
      // Far longer than the test: any access check after the reconcile's own is the close's.
      retryMs: 60_000,
    });
    try {
      runtime.start();
      await settleUntil(() => closed, 'the archived close is read');
      const afterArchived = resolveConnectionAccess.mock.calls.length;
      runtime.stop();

      closeReason = 'access-revoked';
      closed = false;
      resolveConnectionAccess.mockClear();
      const second = new RemoteRoomSubscriptionRuntime({
        bridge,
        enrollments,
        resolveConnectionAccess,
        adapters: () => ({ listRooms: async () => [room], subscribeNativeRoom }),
        resolveLocalAgentAuthor: () => agent.id,
        isRoomJoined: () => true,
        retryMs: 60_000,
      });
      second.start();
      await settleUntil(() => closed, 'the removed close is read');
      await vi.waitFor(() =>
        expect(resolveConnectionAccess.mock.calls.length).toBe(afterArchived + 1)
      );
      expect(resolveConnectionAccess).toHaveBeenLastCalledWith(REF, harness.human);
      second.stop();
    } finally {
      runtime.stop();
    }
  });

  // Purpose (member erasure task 2.1): a subscribed room reads its redaction feed as the
  // enrolled agent after every completed replay and again on the interval, and never before its
  // replay completes. It fails if the sync is not wired, runs as the owner, or stops on the timer.
  it('reads the redaction feed after each replay and on the interval, as the enrolled agent', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    });
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: agent.mintedForManifestId!,
      remoteMemberId: 'remote-ana',
      ownerAuthorId: harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      new RemoteMirrorStore(harness.db, harness.store, harness.authors),
      harness.service,
      enrollments,
      () => agent.id
    );
    const room = testRoom();
    const expected = [
      { communityRef: REF, remoteRoomId: ROOM_ID, ownerAuthorId: harness.human },
      { actingMemberId: 'remote-ana' },
    ];
    const start = (redactionSyncMs: number, replayGate: Promise<void>) => {
      const sync = vi.fn(async (..._args: unknown[]) => undefined);
      const runtime = new RemoteRoomSubscriptionRuntime({
        bridge,
        enrollments,
        resolveConnectionAccess: async () => VERIFIED_AGENT_ACCESS,
        adapters: () => ({
          listRooms: async () => [room],
          subscribeNativeRoom: (_roomId, _cursor, signal) =>
            (async function* () {
              yield snapshot(room, [], 0);
              await replayGate;
              yield { type: 'replay_complete' as const, capturedSeq: 0 };
              await new Promise<void>((resolve) =>
                signal?.addEventListener('abort', () => resolve(), { once: true })
              );
            })(),
        }),
        resolveLocalAgentAuthor: () => agent.id,
        isRoomJoined: () => true,
        retryMs: 60_000,
        redactions: { sync },
        redactionSyncMs,
      });
      runtime.start();
      return { runtime, sync };
    };

    // After the replay: once, and not before it.
    let releaseReplay!: () => void;
    const gate = new Promise<void>((resolve) => (releaseReplay = resolve));
    const replayed = start(60_000, gate);
    try {
      await settleUntil(
        () => replayed.runtime.observation(REF, ROOM_ID, harness.human)?.snapshotComplete === true,
        'the snapshot is cached'
      );
      expect(replayed.sync).not.toHaveBeenCalled();
      releaseReplay();
      await vi.waitFor(() => expect(replayed.sync).toHaveBeenCalledOnce());
      // A replay also re-asks a server that lately answered without the feed.
      expect(replayed.sync).toHaveBeenCalledWith(...expected, { recheck: true });
    } finally {
      replayed.runtime.stop();
    }

    // On the interval while subscribed, and never after stop.
    const timed = start(20, Promise.resolve());
    try {
      await vi.waitFor(() => expect(timed.sync.mock.calls.length).toBeGreaterThanOrEqual(3));
      // One replay call (which re-asks); every other call is the interval's, which honours the
      // hour's wait.
      const [replays, ticks] = [
        timed.sync.mock.calls.filter((call) => call.length === 3),
        timed.sync.mock.calls.filter((call) => call.length === 2),
      ];
      expect(replays).toEqual([[...expected, { recheck: true }]]);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      for (const call of ticks) expect(call).toEqual(expected);
      timed.runtime.stop();
      const stopped = timed.sync.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(timed.sync.mock.calls.length).toBe(stopped);
    } finally {
      timed.runtime.stop();
    }
  });
});
