/**
 * A channel the owner answers in wakes the enrolled host agent on any person's post, mention or
 * not (spec `official-community-space` D11), walked from the live stream bridge through the real
 * RoomService and trigger dispatcher to the turn request the runner receives. The turn is a
 * stranger's in every way that decides power, every wake is paid for from a budget, and every
 * other channel and connection keeps the mention rule exactly as it was.
 *
 * @module services/communities/remote/__tests__/answer-in-wakes
 */
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import { describe, expect, it } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import { permissionSeedForOrigin } from '../../../session/origin/turn-origin.js';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import { RemoteMirrorStore } from '../mirror-store.js';
import {
  RemoteRoomSubscriptionBridge,
  type RemoteLiveEntry,
} from '../remote-room-subscription-bridge.js';
import { AnswerInBudget, answerInChannelName } from '../wake/answer-in.js';
import type { RemoteWakeGate } from '../wake/wake-policy.js';

const REF = 'remote_official' as CommunityRef;
const OTHER = 'remote_other' as CommunityRef;
const OWNER_MEMBER = 'remote-owner-member';
const NOW = Date.parse('2026-10-11T01:00:00.000Z');
const LIVE = { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false } as const;

let seq = 0;

function liveEntry(
  author: RemoteLiveEntry['author'],
  roomId: string,
  mentions: string[] = [],
  community: CommunityRef = REF
): RemoteLiveEntry {
  seq += 1;
  const entry: CommunityEntry = {
    community,
    roomId,
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

function person(memberId: string) {
  return { memberId, displayName: memberId, kind: 'human' } as const;
}

/**
 * The gate the official connection answers with: only the owner's own mention wakes through the
 * ordinary rule, and `help` is answered for anyone, held to `budget`.
 */
function officialGate(
  budget: AnswerInBudget,
  answerIn: readonly string[] = ['help']
): RemoteWakeGate {
  return {
    wakes: (_ref, _owner, memberId) => memberId === OWNER_MEMBER,
    answersIn: (ref, _owner, channel) =>
      ref === REF && answerIn.includes(answerInChannelName(channel)),
    takeAnswerInWake: (ref, owner, channel, author) =>
      budget.take(`${owner}\0${ref}`, answerInChannelName(channel), author),
  };
}

/** A space with Ana enrolled in `#help` and `#general`, wired the way production wires it. */
function space(gate: RemoteWakeGate, communityRef: CommunityRef = REF) {
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
    communityRef,
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
  bridge.useWakeGate(gate);
  const room = (remoteRoomId: string, title: string, accessors = [agent.id]) => {
    const input = {
      communityRef,
      remoteRoomId,
      title,
      topic: null,
      ownerAuthorId: harness.human,
      accessors: accessors.map((authorId) => ({ authorId, responseMode: 'always' as const })),
      authorizedAt: new Date(NOW).toISOString(),
    };
    mirrors.ensureRoom(input);
    return input;
  };
  return {
    harness,
    bridge,
    agent,
    help: room('help', 'help'),
    general: room('general', 'General'),
    room,
  };
}

describe('a channel the owner answers in', () => {
  it('wakes the host agent on a stranger’s post with no mention, as a stranger’s turn', async () => {
    const { harness, bridge, help } = space(officialGate(new AnswerInBudget()));

    bridge.importLive(help, liveEntry(person('remote-stranger'), 'help'), LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(1);
    const turn = harness.runner.turns[0]!;
    expect(turn.externalAuthor).toBe(true);
    expect(turn.permissionCeiling).toBe('runtime-default');
    expect(permissionSeedForOrigin({ kind: 'room', externalAuthor: turn.externalAuthor! })).toBe(
      'none'
    );
  });

  it('keeps the post as its author wrote it: nobody is added to its mentions', async () => {
    const { harness, bridge, help } = space(officialGate(new AnswerInBudget()));

    bridge.importLive(help, liveEntry(person('remote-stranger'), 'help'), LIVE);
    await harness.service.triggersIdle();

    const local = harness.store.listRooms().find((room) => room.title === 'help')!;
    expect(harness.store.listEntriesAfter(local.id, 0)[0]!.mentions).toEqual([]);
  });

  it('never wakes for another agent’s post there', async () => {
    const { harness, bridge, help } = space(officialGate(new AnswerInBudget()));

    bridge.importLive(
      help,
      liveEntry({ memberId: 'remote-bot', displayName: 'Bot', kind: 'agent' }, 'help'),
      LIVE
    );
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
  });

  it('never wakes for a message that was removed before it arrived', async () => {
    const { harness, bridge, help } = space(officialGate(new AnswerInBudget()));
    const removed = liveEntry(person('remote-stranger'), 'help');
    removed.entry.text = '';

    bridge.importLive(help, removed, LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
  });

  it('wakes only an enrolled agent that can read the channel', async () => {
    const { harness, bridge, room } = space(officialGate(new AnswerInBudget()));
    const closed = room('help-closed', 'help', []);

    bridge.importLive(closed, liveEntry(person('remote-stranger'), 'help-closed'), LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
  });
});

describe('everywhere else the mention rule is unchanged', () => {
  it('a channel outside the list wakes nobody without a mention, even for the owner', async () => {
    const { harness, bridge, general } = space(officialGate(new AnswerInBudget()));

    bridge.importLive(general, liveEntry(person('remote-stranger'), 'general'), LIVE);
    bridge.importLive(general, liveEntry(person(OWNER_MEMBER), 'general'), LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
  });

  it('a stranger’s mention outside the list still follows the owner’s wake setting', async () => {
    const { harness, bridge, general } = space(officialGate(new AnswerInBudget()));

    bridge.importLive(
      general,
      liveEntry(person('remote-stranger'), 'general', ['remote-ana']),
      LIVE
    );
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
  });

  it('another connection with a channel of the same name keeps the mention rule', async () => {
    const { harness, bridge, help } = space(officialGate(new AnswerInBudget()), OTHER);

    bridge.importLive(help, liveEntry(person('remote-stranger'), 'help', [], OTHER), LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(0);
  });
});

describe('the budget a flood runs into', () => {
  const LIMITS = { windowMs: 60_000, perAuthor: 2, perChannel: 3 };

  it('gives one person only their share of answers', async () => {
    const { harness, bridge, help } = space(officialGate(new AnswerInBudget(LIMITS, () => NOW)));

    for (let index = 0; index < 6; index += 1) {
      bridge.importLive(help, liveEntry(person('remote-flooder'), 'help'), LIVE);
      await harness.service.triggersIdle();
    }

    expect(harness.runner.turns).toHaveLength(2);
  });

  it('gives one channel only its share, however many people post', async () => {
    const { harness, bridge, help } = space(officialGate(new AnswerInBudget(LIMITS, () => NOW)));

    for (let index = 0; index < 6; index += 1) {
      bridge.importLive(help, liveEntry(person(`remote-person-${index}`), 'help'), LIVE);
      await harness.service.triggersIdle();
    }

    expect(harness.runner.turns).toHaveLength(3);
  });

  it('holds a stranger’s mention there to the budget too', async () => {
    const { harness, bridge, help } = space(
      officialGate(new AnswerInBudget({ ...LIMITS, perAuthor: 1 }, () => NOW))
    );

    bridge.importLive(help, liveEntry(person('remote-flooder'), 'help', ['remote-ana']), LIVE);
    await harness.service.triggersIdle();
    bridge.importLive(help, liveEntry(person('remote-flooder'), 'help', ['remote-ana']), LIVE);
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(1);
  });

  it('never charges a mention the owner’s setting already allows', async () => {
    const budget = new AnswerInBudget({ ...LIMITS, perAuthor: 1 }, () => NOW);
    const { harness, bridge, help } = space(officialGate(budget));

    for (let index = 0; index < 3; index += 1) {
      bridge.importLive(help, liveEntry(person(OWNER_MEMBER), 'help', ['remote-ana']), LIVE);
      await harness.service.triggersIdle();
    }

    expect(harness.runner.turns).toHaveLength(3);
    expect(budget.take(`${harness.human}\0${REF}`, 'help', OWNER_MEMBER)).toBe(true);
  });
});
