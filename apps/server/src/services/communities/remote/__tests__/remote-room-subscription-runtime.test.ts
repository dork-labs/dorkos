/** @vitest-environment node */
import type { CommunityEntry, CommunityRef, CommunityRoom } from '@dorkos/shared/community-adapter';
import { describe, expect, it } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
} from '../../../rooms/__tests__/room-test-harness.js';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
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

function entry(seq: number): CommunityEntry {
  return {
    community: REF,
    roomId: ROOM_ID,
    id: `entry-${seq}`,
    authorId: 'remote-human',
    text: `message ${seq}`,
    mentions: ['remote-ana'],
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
});
