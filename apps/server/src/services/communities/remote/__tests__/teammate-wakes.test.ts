/**
 * A teammate in a space (a member who is not this install's owner) wakes an agent here only as a
 * teammate (DOR-2955): within a budget, on a runtime that can hold the turn, and with a turn the
 * runner sends read-only, with nobody to ask and fenced to its room. The owner's own posts keep
 * today's power. Walked from the live stream bridge through the real RoomService and trigger
 * dispatcher to the turn request the runner receives; the runner's and runtime's halves are pinned
 * in `room-turn-runner.test.ts` and `teammate-fence-hook.test.ts`.
 *
 * @module services/communities/remote/__tests__/teammate-wakes
 */
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import { describe, expect, it } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import { RemoteMirrorStore } from '../mirror-store.js';
import {
  RemoteRoomSubscriptionBridge,
  type RemoteLiveEntry,
} from '../remote-room-subscription-bridge.js';
import type { RemoteWakeGate } from '../wake/wake-policy.js';

const REF = 'remote_team_space' as CommunityRef;
const OWNER_MEMBER = 'remote-owner-member';
const START = Date.parse('2026-10-16T09:00:00.000Z');
const LIVE = { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false } as const;
const TEAMMATE_CEILING = ['runtime-default', READ_ONLY_LEVEL];

const TEAMMATE = { memberId: 'remote-bo', displayName: 'Bo', kind: 'human' } as const;
const OTHER_TEAMMATE = { memberId: 'remote-cy', displayName: 'Cy', kind: 'human' } as const;
const OWNER = { memberId: OWNER_MEMBER, displayName: 'Me', kind: 'human' } as const;

/** Everybody may wake agents here (the default), and the space knows the owner's member id. */
const members: RemoteWakeGate = {
  wakes: (ref) => ref === REF,
  isOwnerPost: (ref, _owner, memberId) => ref === REF && memberId === OWNER_MEMBER,
};

let seq = 0;

/** A space mirror with Ana enrolled, a clock the test moves, and the gate production wires. */
function space(opts: { gate?: RemoteWakeGate; runsTeammateTurns?: boolean } = {}) {
  const clock = { now: START };
  const state: { mirrors?: RemoteMirrorStore } = {};
  const harness: RoomHarness = createRoomHarness({
    agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    mirrorAccess: {
      canRead: (roomId, authorId) => state.mirrors?.canRead(roomId, authorId) ?? null,
      hasMirrors: () => state.mirrors?.hasMirrors() ?? false,
      isRevokedMirrorOf: (roomId, ownerAuthorId) =>
        state.mirrors?.isRevokedMirrorOf(roomId, ownerAuthorId) ?? false,
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
    () => clock.now
  );
  if (opts.gate !== undefined) bridge.useWakeGate(opts.gate);
  if (opts.runsTeammateTurns !== false) bridge.useTeammateRuntimes(() => true);
  const room = {
    communityRef: REF,
    remoteRoomId: 'general',
    title: 'General',
    topic: null,
    ownerAuthorId: harness.human,
    accessors: [{ authorId: agent.id, responseMode: 'always' as const }],
    authorizedAt: new Date(START).toISOString(),
  };
  const localRoom = mirrors.ensureRoom(room);

  /** Post one fresh live frame mentioning Ana, and let every turn it starts finish. */
  async function post(author: RemoteLiveEntry['author']) {
    seq += 1;
    const at = new Date(clock.now).toISOString();
    const entry: CommunityEntry = {
      community: REF,
      roomId: 'general',
      id: `team-entry-${seq}`,
      authorId: author.memberId,
      text: `@ana message ${seq}`,
      mentions: ['remote-ana'],
      parentEntryId: null,
      threadRootEntryId: null,
      depth: 0,
      cursor: `team-cursor-${seq}` as CommunityEntry['cursor'],
      createdAt: at,
    };
    bridge.importLive(room, { entry, remoteSeq: seq, author, serverCreatedAt: at }, LIVE);
    await harness.service.triggersIdle();
  }
  return { harness, clock, localRoom, post };
}

describe('a teammate’s mention', () => {
  it('starts a teammate’s turn: read-only, with nobody to ask, fenced to the room', async () => {
    const { harness, localRoom, post } = space({ gate: members });

    await post(TEAMMATE);

    expect(harness.runner.turns).toHaveLength(1);
    const turn = harness.runner.turns[0]!;
    expect(turn.teammate).toBe(true);
    expect(turn.externalAuthor).toBe(true);
    expect(turn.permissionCeiling).toEqual(TEAMMATE_CEILING);
    expect(turn.roomContext.room.id).toBe(localRoom.id);
  });

  it('is held to the teammate rules when no gate can say who the owner is', async () => {
    const { harness, post } = space();

    await post(OWNER);

    expect(harness.runner.turns[0]!.teammate).toBe(true);
  });

  it('wakes nobody on an agent whose runtime cannot hold the turn, and stays history', async () => {
    const { harness, localRoom, post } = space({ gate: members, runsTeammateTurns: false });

    await post(TEAMMATE);

    expect(harness.runner.turns).toHaveLength(0);
    expect(harness.store.listEntriesAfter(localRoom.id, 0)).toHaveLength(1);
  });

  it('wakes an agent three times per person every ten minutes, then keeps posts as history', async () => {
    const { harness, clock, post } = space({ gate: members });

    for (let i = 0; i < 4; i += 1) await post(TEAMMATE);
    expect(harness.runner.turns).toHaveLength(3);

    // Somebody else has their own share.
    await post(OTHER_TEAMMATE);
    expect(harness.runner.turns).toHaveLength(4);

    // And the window moves on.
    clock.now += 10 * 60_000 + 1;
    await post(TEAMMATE);
    expect(harness.runner.turns).toHaveLength(5);
  });
});

describe('the owner’s own post in the space', () => {
  it('keeps today’s power: a stranger’s ceiling, no fence, and nobody else’s budget', async () => {
    const { harness, post } = space({ gate: members });

    for (let i = 0; i < 5; i += 1) await post(OWNER);

    expect(harness.runner.turns).toHaveLength(5);
    for (const turn of harness.runner.turns) {
      expect(turn.teammate).toBeUndefined();
      expect(turn.permissionCeiling).toBe('runtime-default');
    }
  });

  it('still wakes an agent whose runtime cannot take a teammate’s turn', async () => {
    const { harness, post } = space({ gate: members, runsTeammateTurns: false });

    await post(OWNER);

    expect(harness.runner.turns).toHaveLength(1);
  });
});
