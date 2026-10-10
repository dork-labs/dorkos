/**
 * A space message from somebody who is not this install's owner never hands that person power
 * here (spec `official-community-space` D9, D10), walked from the live stream bridge through the
 * real RoomService and trigger dispatcher to the turn request the runner receives.
 *
 * The other half of the walk — the turn request's `permissionCeiling` to the mode each runtime
 * runs at — is pinned by the runner and runtime tests of spec `trusted-by-default-flip` §4
 * (`rooms/__tests__/room-turn-runner.test.ts`, `runtimes/__tests__/turn-permission-ceiling.test.ts`).
 * Together they are the end-to-end pin: a stranger's mention arrives here carrying the
 * `'runtime-default'` ceiling and `externalAuthor: true`, which `permissionSeedForOrigin` reads as
 * `'none'` for a new conversation's row.
 *
 * @module services/communities/remote/__tests__/space-stranger-safety
 */
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import { describe, expect, it } from 'vitest';
import { authorOrigin } from '../../../rooms/author-registry.js';
import {
  agentLookupFor,
  createRoomHarness,
  gatedRunner,
  settleUntil,
  type RoomHarness,
  type ScriptedTurnRunner,
} from '../../../rooms/__tests__/room-test-harness.js';
import { formatRoomContext } from '../../../runtimes/shared/room-context-block.js';
import { permissionSeedForOrigin } from '../../../session/origin/turn-origin.js';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import { RemoteMirrorStore } from '../mirror-store.js';
import {
  RemoteRoomSubscriptionBridge,
  type RemoteLiveEntry,
} from '../remote-room-subscription-bridge.js';
import type { RemoteWakeGate } from '../wake-policy.js';

const REF = 'remote_space' as CommunityRef;
const OWNER_MEMBER = 'remote-owner-member';
const NOW = Date.parse('2026-10-06T01:00:00.000Z');
const LIVE = { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false } as const;

let seq = 0;

/** One fresh live frame in `general`, mentioning `mentions`, by `author`. */
function liveEntry(author: RemoteLiveEntry['author'], mentions: string[]): RemoteLiveEntry {
  seq += 1;
  const entry: CommunityEntry = {
    community: REF,
    roomId: 'general',
    id: `entry-${seq}`,
    authorId: author.memberId,
    text: `message ${seq}`,
    mentions,
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `cursor-${seq}` as CommunityEntry['cursor'],
    createdAt: new Date(NOW).toISOString(),
  };
  return { entry, remoteSeq: seq, author, serverCreatedAt: new Date(NOW).toISOString() };
}

const STRANGER = { memberId: 'remote-stranger', displayName: 'Stranger', kind: 'human' } as const;
const OWNER_ELSEWHERE = { memberId: OWNER_MEMBER, displayName: 'Me', kind: 'human' } as const;

/** A space mirror with Ana enrolled, wired the way production wires it. */
function space(gate?: RemoteWakeGate, runner?: ScriptedTurnRunner) {
  const state: { mirrors?: RemoteMirrorStore } = {};
  const harness: RoomHarness = createRoomHarness({
    ...(runner ? { runner } : {}),
    agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    mirrorAccess: {
      canRead: (roomId, authorId) => state.mirrors?.canRead(roomId, authorId) ?? null,
      hasMirrors: () => state.mirrors?.hasMirrors() ?? false,
      isRevokedMirrorOf: (roomId, ownerAuthorId) =>
        state.mirrors?.isRevokedMirrorOf(roomId, ownerAuthorId) ?? false,
      isMirror: (roomId) => state.mirrors?.isMirror(roomId) ?? false,
    },
  });
  const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
  state.mirrors = mirrors;
  const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
  const enrollments = new CommunityAgentEnrollmentStore(harness.db);
  enrollments.activate({
    communityRef: REF,
    localAgentId: 'local-ana',
    remoteMemberId: 'remote-ana',
    ownerAuthorId: harness.human,
  });
  const bridge = new RemoteRoomSubscriptionBridge(
    mirrors,
    harness.service,
    enrollments,
    (localAgentId) => (localAgentId === 'local-ana' ? agent.id : null),
    () => NOW
  );
  if (gate) bridge.useWakeGate(gate);
  const room = {
    communityRef: REF,
    remoteRoomId: 'general',
    title: 'General',
    topic: null,
    ownerAuthorId: harness.human,
    accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    authorizedAt: new Date(NOW).toISOString(),
  };
  const localRoom = mirrors.ensureRoom(room);
  return { harness, mirrors, bridge, agent, room, localRoom };
}

/** The wake gate a connection set to `me` answers with, for this test's one space. */
const onlyMe: RemoteWakeGate = {
  wakes: (ref, _owner, memberId) => ref === REF && memberId === OWNER_MEMBER,
};

describe('a stranger in a space (D10)', () => {
  it('wakes the agent as somebody from off this machine, so the turn can give them no power', async () => {
    const { harness, bridge, room } = space();

    bridge.importLive(room, liveEntry(STRANGER, ['remote-ana']), LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(1);
    const turn = harness.runner.turns[0]!;
    // The fact the turn runner reads for the ceiling, and the origin's seed reads for the row.
    expect(turn.externalAuthor).toBe(true);
    expect(turn.permissionCeiling).toBe('runtime-default');
    expect(permissionSeedForOrigin({ kind: 'room', externalAuthor: turn.externalAuthor! })).toBe(
      'none'
    );
  });

  it('tells the agent people outside this machine post in the space', async () => {
    const { harness, bridge, room } = space();

    bridge.importLive(room, liveEntry(STRANGER, ['remote-ana']), LIVE);
    await harness.service.triggersIdle();

    const context = harness.runner.turns[0]!.roomContext;
    expect(context.room.bridged).toBe(true);
    // No far-end formatting rules and no partial-visibility line: those are a chat bridge's.
    expect(context.room.formatting).toBeUndefined();
    expect(context.room.visibility).toBeUndefined();
    expect(formatRoomContext(context)).toContain(
      'This channel also receives messages from people outside this machine.'
    );
  });

  it('frames the owner’s own turn there the same way, since strangers post in the room', async () => {
    const { harness, localRoom } = space();

    harness.service.post(localRoom.id, { authorId: harness.human, text: 'local question' });
    await harness.service.triggersIdle();

    const turn = harness.runner.turns[0]!;
    expect(turn.externalAuthor).toBe(false);
    expect(turn.permissionCeiling).toBeUndefined();
    expect(turn.roomContext.room.bridged).toBe(true);
  });

  it('owner first, stranger second: the stranger’s turn is still external', async () => {
    // The scenario D10 exists for. The owner's own message starts the room's session at the
    // owner's level; a stranger's later mention lands on that same session. What decides the
    // stranger's turn is this flag, never the row the owner's turn left behind.
    const { harness, bridge, room, localRoom } = space();

    harness.service.post(localRoom.id, { authorId: harness.human, text: 'owner first' });
    await harness.service.triggersIdle();
    bridge.importLive(room, liveEntry(STRANGER, ['remote-ana']), LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns.map((turn) => turn.externalAuthor)).toEqual([false, true]);
    expect(harness.runner.turns.map((turn) => turn.permissionCeiling)).toEqual([
      undefined,
      'runtime-default',
    ]);
    // Same agent, same room conversation.
    expect(harness.runner.turns[1]!.agentPath).toBe(harness.runner.turns[0]!.agentPath);
  });

  it('stranger then owner while the agent is busy: the merged turn is still external', async () => {
    // One turn answers both messages, triggered by the owner's newer one. The
    // stranger's message gathered behind it must still hold that turn down.
    const runner = gatedRunner();
    const { harness, bridge, room, localRoom, agent } = space(undefined, runner);

    harness.service.post(localRoom.id, { authorId: harness.human, text: 'owner, first turn' });
    await settleUntil(() => runner.holdsFor(agent.id) === 1, 'the owner’s turn to be running');
    bridge.importLive(room, liveEntry(STRANGER, ['remote-ana']), LIVE);
    harness.service.post(localRoom.id, { authorId: harness.human, text: 'owner, while busy' });

    // Nothing reaches the running turn: both wait for a turn of their own.
    expect(runner.turns).toHaveLength(1);
    runner.release(agent.id);
    await settleUntil(() => runner.turns.length === 2, 'the merged turn to start');

    const merged = runner.turns[1]!;
    expect(merged.prompt).toBe('owner, while busy');
    expect(merged.externalAuthor).toBe(true);
    expect(merged.permissionCeiling).toBe('runtime-default');
    runner.releaseAll();
    await harness.service.triggersIdle();
  });

  it('owner then stranger while the agent is busy: the owner’s running turn is never steered', async () => {
    const runner = gatedRunner();
    const { harness, bridge, room, localRoom, agent } = space(undefined, runner);

    harness.service.post(localRoom.id, { authorId: harness.human, text: 'owner first' });
    await settleUntil(() => runner.holdsFor(agent.id) === 1, 'the owner’s turn to be running');
    bridge.importLive(room, liveEntry(STRANGER, ['remote-ana']), LIVE);

    expect(runner.turns).toHaveLength(1);
    expect(runner.turns[0]!.externalAuthor).toBe(false);
    expect(runner.turns[0]!.permissionCeiling).toBeUndefined();
    runner.release(agent.id);
    await settleUntil(() => runner.turns.length === 2, 'the stranger’s own turn to start');
    expect(runner.turns[1]!.externalAuthor).toBe(true);
    expect(runner.turns[1]!.permissionCeiling).toBe('runtime-default');
    runner.releaseAll();
    await harness.service.triggersIdle();
  });

  it('never dispatches a remote agent’s message, even one that mentions ours', async () => {
    const { harness, bridge, room } = space();

    bridge.importLive(
      room,
      liveEntry({ memberId: 'remote-bot', displayName: 'Bot', kind: 'agent' }, ['remote-ana']),
      LIVE
    );
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
  });

  it('cannot speak as our enrolled agent by borrowing its member id or name', async () => {
    const { harness, bridge, room, localRoom, agent } = space();

    bridge.importLive(
      room,
      liveEntry({ memberId: 'remote-ana', displayName: 'Ana', kind: 'human' }, ['remote-ana']),
      LIVE
    );
    await harness.service.triggersIdle();

    const stored = harness.store.listEntriesAfter(localRoom.id, 0)[0]!;
    expect(stored.authorId).not.toBe(agent.id);
    expect(authorOrigin(harness.authors.getById(stored.authorId)!.naturalKey)).not.toBe('local');
    for (const turn of harness.runner.turns) {
      expect(turn.externalAuthor).toBe(true);
      expect(turn.permissionCeiling).toBe('runtime-default');
    }
  });

  it('cannot enroll another local agent by mentioning it', async () => {
    const { harness, bridge, room } = space();
    harness.authors.resolveAgent('/agents/bo', 'Bo');

    // `remote-bo` is no enrollment of this owner's, so it names nobody here.
    bridge.importLive(room, liveEntry(STRANGER, ['remote-bo']), LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
  });
});

describe('who may wake an agent in a space (D9)', () => {
  it('with "me", a stranger’s mention is kept as history and wakes nobody', async () => {
    const { harness, mirrors, bridge, room, localRoom } = space(onlyMe);

    const entry = liveEntry(STRANGER, ['remote-ana']);
    bridge.importLive(room, entry, LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
    expect(harness.store.listEntriesAfter(localRoom.id, 0)).toHaveLength(1);
    // Never claimed, so nothing records it as a message that was answered.
    expect(
      mirrors.claimRemoteDispatch(REF, 'general', entry.entry.id, new Date(NOW).toISOString())
    ).toBe(true);
  });

  it('with "me", the owner’s own account still wakes the agent', async () => {
    const { harness, bridge, room } = space(onlyMe);

    bridge.importLive(room, liveEntry(OWNER_ELSEWHERE, ['remote-ana']), LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(1);
  });
});
