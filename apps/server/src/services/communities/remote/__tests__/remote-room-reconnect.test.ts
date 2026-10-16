/** @vitest-environment node */
/**
 * What a dropped link to a space costs (DOR-2976). The stream reconnects from where it stopped,
 * so a mention posted while it was down still wakes the agent when the link comes back, while an
 * old one stays history. And a dropped link no longer turns the room's copy stale: only the space
 * refusing access does, so an agent's reply in that moment is not refused.
 */
import {
  CommunityRoomNotFoundError,
  StaleCommunityCursorError,
  type CommunityEntry,
  type CommunityRef,
  type CommunityRoom,
} from '@dorkos/shared/community-adapter';
import type { CommunityConnectionAccess } from '@dorkos/shared/community-wire';
import { describe, expect, it, vi } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
} from '../../../rooms/__tests__/room-test-harness.js';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import { RemoteMirrorStore } from '../mirror-store.js';
import { PinnedHttpError, PinnedOriginError } from '../pinned-origin.js';
import type { RemoteNativeRoomEvent } from '../remote-community-adapter.js';
import {
  RemoteRoomSubscriptionBridge,
  type RemoteLiveEntry,
} from '../remote-room-subscription-bridge.js';
import { RemoteRoomSubscriptionRuntime } from '../remote-room-subscription-runtime.js';
import { endsAccess } from '../subscription/remote-room-frames.js';
import { RemoteConnectionAuthorizationError } from '../connection-store.js';
import { CommunityDeletedError } from '../remote-community-adapter.js';

const REF = 'remote_owner_a' as CommunityRef;
const ROOM_ID = 'room-a';
const VERIFIED = {
  state: 'verified',
  effective: { read: true, post: true, enrollAgent: true, stream: true },
  lastKnown: {
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
    verifiedAt: '2026-09-21T12:00:00.000Z',
  },
} as const;
const ROOM: CommunityRoom = {
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
const LONG_AGO = '2026-09-16T01:00:00.000Z';
const NO_ACCESS = { read: false, post: false, enrollAgent: false, stream: false };

function entry(seq: number, createdAt: string, mentions = ['remote-ana']): CommunityEntry {
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
    createdAt,
  };
}

function snapshot(entries: CommunityEntry[], capturedSeq: number): RemoteNativeRoomEvent {
  return {
    type: 'snapshot',
    room: ROOM,
    entries,
    capturedSeq,
    // As the space sets it: just after the last entry this snapshot carries.
    cursor: entries.at(-1)?.cursor ?? (`cursor-${capturedSeq}` as CommunityEntry['cursor']),
  };
}

/**
 * A space whose first stream delivers history and then fails with `drop`, and whose second
 * stream, opened from wherever the first stopped, carries `missed` and then stays open.
 */
function setup(opts: {
  missed: CommunityEntry[];
  drop: Error;
  resumeRefused?: boolean;
  /** Replay entries the first stream carries after its snapshot, before replay completes. */
  firstReplay?: CommunityEntry[];
}) {
  // Rooms read mirror access from the same store the bridge writes, as production wires it, so
  // a stale copy is as closed to the agent here as it is there.
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
    localAgentId: agent.id,
    remoteMemberId: 'remote-ana',
    ownerAuthorId: harness.human,
  });
  const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
  state.mirrors = mirrors;
  const bridge = new RemoteRoomSubscriptionBridge(mirrors, harness.service, enrollments, (id) =>
    id === agent.id ? agent.id : null
  );
  const markStale = vi.spyOn(bridge, 'markStale');
  let dropLink: () => void = () => undefined;
  const dropped = new Promise<void>((resolve) => (dropLink = resolve));
  let endSecond: () => void = () => undefined;
  const secondEnds = new Promise<void>((resolve) => (endSecond = resolve));
  const opened: Array<string | undefined> = [];
  // What the access check answers; a test switches it to model a space it cannot reach.
  let access: CommunityConnectionAccess = VERIFIED;
  let firstAborted = false;
  const runtime = new RemoteRoomSubscriptionRuntime({
    bridge,
    enrollments,
    resolveConnectionAccess: async () => access,
    adapters: () => ({
      async listRooms() {
        return [ROOM];
      },
      subscribeNativeRoom(_roomId, sinceCursor, signal) {
        opened.push(sinceCursor);
        if (opened.length === 1)
          return (async function* () {
            const replay = opts.firstReplay ?? [];
            const captured = 1 + replay.length;
            yield snapshot([entry(1, LONG_AGO)], captured);
            for (const value of replay) yield { type: 'entry' as const, entry: value };
            yield { type: 'replay_complete' as const, capturedSeq: captured };
            const aborted = new Promise<void>((resolve) =>
              signal?.addEventListener('abort', () => resolve(), { once: true })
            );
            await Promise.race([dropped, aborted]);
            if (signal?.aborted) {
              firstAborted = true;
              return;
            }
            throw opts.drop;
          })();
        // The space no longer accepts the cursor the first stream ended on.
        if (opts.resumeRefused && opened.length === 2)
          return (async function* () {
            yield* [];
            throw new StaleCommunityCursorError(REF, ROOM_ID, 'cursor too old');
          })();
        return (async function* () {
          const last = 1 + (opts.firstReplay?.length ?? 0) + opts.missed.length;
          yield snapshot(opts.missed, last);
          yield { type: 'replay_complete' as const, capturedSeq: last };
          await secondEnds;
        })();
      },
    }),
    resolveLocalAgentAuthor: (id) => (id === agent.id ? agent.id : null),
    isRoomJoined: () => true,
    toLiveEntry: (value): RemoteLiveEntry => ({
      entry: value,
      remoteSeq: Number(value.id.slice('entry-'.length)),
      author: { memberId: 'remote-human', displayName: 'Remote human', kind: 'human' },
      serverCreatedAt: value.createdAt,
    }),
    retryMs: 1,
  });
  const observation = () => runtime.observation(REF, ROOM_ID, harness.human);
  const stop = () => {
    endSecond();
    runtime.stop();
  };
  const localRoomId = () => mirrors.localRoomIdForOwner(REF, ROOM_ID, harness.human)!;
  return {
    harness,
    agent,
    runtime,
    opened,
    dropLink,
    observation,
    stop,
    localRoomId,
    markStale,
    setAccess: (next: CommunityConnectionAccess) => (access = next),
    firstAborted: () => firstAborted,
  };
}

describe('a dropped link to a space', () => {
  it('resumes where it stopped, and a mention posted while it was down wakes the agent', async () => {
    // Catches a reconnect that starts fresh: the mention would come back in a snapshot, which
    // never wakes anyone, and no turn would run.
    const t = setup({
      missed: [entry(2, new Date().toISOString())],
      drop: new PinnedOriginError('REMOTE_UNAVAILABLE'),
    });
    t.runtime.start();
    await settleUntil(() => t.observation()?.replayComplete === true, 'the first stream is in');
    await t.harness.service.triggersIdle();
    expect(t.harness.runner.turns).toHaveLength(0);

    t.dropLink();
    await settleUntil(
      () => t.observation()?.dispatchesSinceBoot === 1,
      'the missed mention is dispatched'
    );
    await t.harness.service.triggersIdle();
    expect(t.opened).toEqual([undefined, 'cursor-1']);
    expect(t.harness.runner.turns).toHaveLength(1);
    t.stop();
  });

  it('keeps an old message it missed as history', async () => {
    // Catches resuming without the freshness check: a reconnect after a long sleep would wake
    // agents for every mention of the last hours.
    const t = setup({
      missed: [entry(2, LONG_AGO)],
      drop: new PinnedOriginError('REMOTE_UNAVAILABLE'),
    });
    t.runtime.start();
    await settleUntil(() => t.observation()?.replayComplete === true, 'the first stream is in');
    t.dropLink();
    await settleUntil(
      () => t.observation()?.generation === 2 && t.observation()?.replayComplete === true,
      'the resumed stream is in'
    );
    await t.harness.service.triggersIdle();
    expect(t.opened).toEqual([undefined, 'cursor-1']);
    expect(t.observation()?.dispatchesSinceBoot).toBe(0);
    expect(t.harness.runner.turns).toHaveLength(0);
    t.stop();
  });

  it('leaves the room readable to the agent, so a reply in that moment is not refused', async () => {
    // Catches a transport error marking the copy stale, which admits only the person.
    const t = setup({ missed: [], drop: new PinnedOriginError('REMOTE_UNAVAILABLE') });
    t.runtime.start();
    await settleUntil(() => t.observation()?.replayComplete === true, 'the first stream is in');
    t.dropLink();
    await settleUntil(() => t.observation()?.generation === 2, 'the link reconnects');
    expect(t.markStale).not.toHaveBeenCalled();
    expect(() =>
      t.harness.service.postFromTool(t.localRoomId(), { authorId: t.agent.id, text: 'On it.' })
    ).not.toThrow();
    t.stop();
  });

  it('still turns the copy stale when the space refuses access', async () => {
    // Catches the fix going too far: a refusal must still close the copy to the agent. (This
    // test's refresh runs every millisecond and re-opens it at once, so the call is the evidence.)
    const t = setup({ missed: [], drop: new PinnedHttpError(403) });
    t.runtime.start();
    await settleUntil(() => t.observation()?.replayComplete === true, 'the first stream is in');
    t.dropLink();
    await settleUntil(() => t.observation()?.generation === 2, 'the link reconnects');
    expect(t.markStale).toHaveBeenCalledWith(REF, t.harness.human);
    t.stop();
  });

  it('starts fresh when the space no longer accepts where the last stream stopped', async () => {
    // Catches a refused cursor being retried forever: the room would never stream again.
    const t = setup({
      missed: [],
      drop: new PinnedOriginError('REMOTE_UNAVAILABLE'),
      resumeRefused: true,
    });
    t.runtime.start();
    await settleUntil(() => t.observation()?.replayComplete === true, 'the first stream is in');
    t.dropLink();
    await settleUntil(() => t.opened.length === 3, 'the link reconnects twice');
    expect(t.opened).toEqual([undefined, 'cursor-1', undefined]);
    expect(t.markStale).not.toHaveBeenCalled();
    t.stop();
  });

  it('resumes after the space could not be reached for a while, keeping the copy open', async () => {
    // Catches the access check undoing the fix: during an outage it cannot reach the space
    // either, so it tears the stream down. Marking the copy stale then would refuse a reply in
    // flight, and starting the next stream fresh would lose the mention sent meanwhile.
    const t = setup({
      firstReplay: [entry(2, LONG_AGO, [])],
      missed: [entry(3, new Date().toISOString())],
      drop: new PinnedOriginError('REMOTE_UNAVAILABLE'),
    });
    t.runtime.start();
    await settleUntil(() => t.observation()?.replayComplete === true, 'the first stream is in');

    t.setAccess({ state: 'unverified', effective: NO_ACCESS, lastKnown: VERIFIED.lastKnown });
    await settleUntil(() => t.firstAborted(), 'the unreachable connection stops streaming');
    expect(t.markStale).not.toHaveBeenCalled();
    expect(() =>
      t.harness.service.postFromTool(t.localRoomId(), { authorId: t.agent.id, text: 'On it.' })
    ).not.toThrow();

    t.setAccess(VERIFIED);
    await settleUntil(
      () => t.observation()?.dispatchesSinceBoot === 1,
      'the mention sent during the outage is dispatched'
    );
    // Resumed after the last entry it imported, not after the snapshot before it.
    expect(t.opened).toEqual([undefined, 'cursor-2']);
    t.stop();
  });
});

describe('which stream failures end access', () => {
  it('counts a refusal, a removed room or space and a revoked grant, and nothing else', () => {
    // Catches a refusal no longer closing the copy, or a dropped link closing it again.
    for (const refused of [
      new PinnedHttpError(401),
      new PinnedHttpError(403),
      new CommunityRoomNotFoundError(REF, ROOM_ID),
      new CommunityDeletedError(REF, ROOM_ID),
      new RemoteConnectionAuthorizationError(),
    ])
      expect(endsAccess(refused), refused.constructor.name).toBe(true);
    for (const transient of [
      new PinnedOriginError('REMOTE_UNAVAILABLE'),
      new PinnedOriginError('REMOTE_RESPONSE'),
      new PinnedHttpError(500),
      new PinnedHttpError(429),
      new StaleCommunityCursorError(REF, ROOM_ID, 'old'),
      new Error('aborted'),
    ])
      expect(endsAccess(transient), transient.message).toBe(false);
  });
});
