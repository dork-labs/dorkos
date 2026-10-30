/**
 * A teammate in a space (a member who is not this install's owner) wakes an agent here only as a
 * teammate (DOR-2955): within a budget, on a runtime that can hold the turn, and with a turn the
 * runner sends read-only, with nobody to ask and fenced to its room. The owner's own posts keep
 * today's power. Walked from the live stream bridge through the real RoomService and trigger
 * dispatcher to the turn request the runner receives; the runner's and runtime's halves are pinned
 * in `room-turn-runner.test.ts` and `teammate-tier-hook.test.ts`.
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
import { AnswerInBudget, ANSWER_IN_LIMITS } from '../wake/answer-in.js';
import type { RemoteWakeGate } from '../wake/wake-policy.js';

const REF = 'remote_team_space' as CommunityRef;
const OWNER_MEMBER = 'remote-owner-member';
const START = Date.parse('2026-10-16T09:00:00.000Z');
const LIVE = { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false } as const;
/** A teammate's ceiling: the runtime default and read access, which carries their mark (DOR-3036). */
const TEAMMATE_CEILING = [
  'runtime-default',
  {
    ...READ_ONLY_LEVEL,
    teammate: [
      expect.objectContaining({ roomId: expect.any(String), authorId: expect.any(String) }),
    ],
  },
];

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
function space(opts: { gate?: RemoteWakeGate; runsTeammateTurns?: boolean; kind?: 'dm' } = {}) {
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
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
  const localRoom = mirrors.ensureRoom(room);

  /** Post one fresh live frame (mentioning Ana unless told), and let every turn it starts finish. */
  async function post(author: RemoteLiveEntry['author'], mentions: string[] = ['remote-ana']) {
    seq += 1;
    const at = new Date(clock.now).toISOString();
    const entry: CommunityEntry = {
      community: REF,
      roomId: 'general',
      id: `team-entry-${seq}`,
      authorId: author.memberId,
      text: `@ana message ${seq}`,
      mentions,
      parentEntryId: null,
      threadRootEntryId: null,
      depth: 0,
      cursor: `team-cursor-${seq}` as CommunityEntry['cursor'],
      createdAt: at,
    };
    bridge.importLive(room, { entry, remoteSeq: seq, author, serverCreatedAt: at }, LIVE);
    await harness.service.triggersIdle();
  }
  return { harness, clock, localRoom, agent, post };
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

describe('in the space’s local copy', () => {
  it('holds a message whose author resolves to nobody to the teammate rules', async () => {
    // Review should-fix 3: in a space's copy, only a vouch or this machine keeps the owner's power.
    const { harness, localRoom, agent, post } = space({ gate: members, runsTeammateTurns: false });
    await post(TEAMMATE); // kept as history: no agent here may take a teammate's turn
    const kept = harness.store.listEntriesAfter(localRoom.id, 0)[0]!;

    harness.service.dispatchImportedRemoteEntry(localRoom.id, {
      ...kept,
      id: 'entry-of-nobody',
      authorId: 'author-nobody-knows',
      mentions: [agent.id],
    });
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(1);
    expect(harness.runner.turns[0]!.teammate).toBe(true);
  });

  it('never holds the owner’s own message here to them', async () => {
    const { harness, localRoom } = space({ gate: members });

    harness.service.post(localRoom.id, { authorId: harness.human, text: '@ana what is new?' });
    await harness.service.triggersIdle();

    expect(harness.runner.turns[0]!.teammate).toBeUndefined();
  });
});

describe('one budget per person', () => {
  /** `members`, answering every post in General too, with the space's own budget or none. */
  function answeringGate(budget?: AnswerInBudget): RemoteWakeGate {
    return {
      ...members,
      answersIn: (ref, _owner, channel) => ref === REF && channel === 'General',
      ...(budget
        ? {
            takeAnswerInWake: (ref, owner, channel, author) =>
              budget.take(`${owner}\0${ref}`, channel, author),
          }
        : {}),
    };
  }

  it.each([
    ['the space’s answer-in budget', () => new AnswerInBudget(ANSWER_IN_LIMITS, () => START)],
    ['the bridge’s own, when the gate keeps none', () => undefined],
  ])('counts mentions and answer-in posts together, from %s', async (_name, budget) => {
    const { harness, post } = space({ gate: answeringGate(budget()) });

    await post(TEAMMATE);
    await post(TEAMMATE, []);
    await post(TEAMMATE);
    await post(TEAMMATE, []);

    expect(harness.runner.turns).toHaveLength(3);
  });
});

describe('the owner’s own post in the space', () => {
  it('runs at the agent’s level: no ceiling, no fence, and nobody else’s budget', async () => {
    const { harness, post } = space({ gate: members });

    for (let i = 0; i < 5; i += 1) await post(OWNER);

    expect(harness.runner.turns).toHaveLength(5);
    for (const turn of harness.runner.turns) {
      expect(turn.teammate).toBeUndefined();
      expect(turn.permissionCeiling).toBeUndefined();
    }
  });

  it('still wakes an agent whose runtime cannot take a teammate’s turn', async () => {
    const { harness, post } = space({ gate: members, runsTeammateTurns: false });

    await post(OWNER);

    expect(harness.runner.turns).toHaveLength(1);
  });
});

describe('a direct message with the agent', () => {
  /** Only the owner wakes agents: the setting that keeps teammates' mentions as history. */
  const ownerOnly: RemoteWakeGate = {
    ...members,
    wakes: (ref, _owner, memberId) => ref === REF && memberId === OWNER_MEMBER,
  };

  it('is addressed to the agent without a mention, as a teammate’s turn', async () => {
    const { harness, post } = space({ gate: members, kind: 'dm' });

    await post(TEAMMATE, []);

    expect(harness.runner.turns).toHaveLength(1);
    const turn = harness.runner.turns[0]!;
    expect(turn.teammate).toBe(true);
    expect(turn.permissionCeiling).toEqual(TEAMMATE_CEILING);
  });

  it('wakes nobody in an ordinary channel without a mention', async () => {
    const { harness, post } = space({ gate: members });

    await post(TEAMMATE, []);

    expect(harness.runner.turns).toHaveLength(0);
  });

  it('pays from the same budget per person', async () => {
    const { harness, post } = space({ gate: members, kind: 'dm' });

    for (let i = 0; i < 4; i += 1) await post(TEAMMATE, []);

    expect(harness.runner.turns).toHaveLength(3);
  });

  it('stays history when the owner lets only themselves wake agents', async () => {
    const { harness, post } = space({ gate: ownerOnly, kind: 'dm' });

    await post(TEAMMATE, []);

    expect(harness.runner.turns).toHaveLength(0);
  });

  it('stays history on an agent whose runtime cannot hold a teammate’s turn', async () => {
    const { harness, post } = space({ gate: members, kind: 'dm', runsTeammateTurns: false });

    await post(TEAMMATE, []);

    expect(harness.runner.turns).toHaveLength(0);
  });
});

describe('the monthly limit on teammates’ turns (DOR-2956)', () => {
  /** `members`, with this space's teammate spending already at its limit. */
  const spent: RemoteWakeGate = {
    ...members,
    withinTeammateSpend: (ref) => ref !== REF,
  };

  it('keeps a teammate’s post as history once the month’s limit is spent', async () => {
    const { harness, localRoom, post } = space({ gate: spent });

    await post(TEAMMATE);

    expect(harness.runner.turns).toHaveLength(0);
    expect(harness.store.listEntriesAfter(localRoom.id, 0)).toHaveLength(1);
  });

  it('still wakes the agent for the owner’s own post', async () => {
    const { harness, post } = space({ gate: spent });

    await post(OWNER);

    expect(harness.runner.turns).toHaveLength(1);
  });

  it('keeps a teammate’s direct message with the agent as history too', async () => {
    // The bridge function is shared: a DM post is held to the same limit as a mention.
    const { harness, post } = space({ gate: spent, kind: 'dm' });

    await post(TEAMMATE, []);

    expect(harness.runner.turns).toHaveLength(0);
  });

  it('wakes as before while the month is within the limit', async () => {
    const { harness, post } = space({ gate: { ...members, withinTeammateSpend: () => true } });

    await post(TEAMMATE);

    expect(harness.runner.turns).toHaveLength(1);
  });
});
