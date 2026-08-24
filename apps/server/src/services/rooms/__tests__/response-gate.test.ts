/**
 * The response gate as a room behaves (spec `engaged-response-gate` §10.2).
 *
 * `response-gate/__tests__/routing-rules.test.ts` pins the rules; this pins the
 * thing a person would notice and the thing an auditor would ask about — that an
 * overheard message meant for somebody else costs nothing at all, that a message
 * meant for THIS agent still gets an answer, and that a skipped message is
 * background on the next turn rather than a message that vanished.
 *
 * Driven through the real {@link RoomService} and the real dispatcher, with only
 * the turn runner scripted. **Every "no turn ran" assertion is made against the
 * runner double rather than against a log line**, for the reason
 * `specs/room-participation/02-specification.md` §8.4 gives: a log assertion
 * cannot catch a turn that ran anyway.
 *
 * @module server/services/rooms/tests/response-gate
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { roomTurnSpend, type Db } from '@dorkos/db';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import type { ResponseGateMode } from '../response-gate/routing-rules.js';
import { recentRefusals, resetDispatchBuffers } from '../../observability/dispatch-buffers.js';
import { logger } from '../../../lib/logger.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana' },
  '/agents/nova': { name: 'nova' },
});

interface Wired {
  db: Db;
  service: RoomService;
  store: RoomStore;
  runner: ScriptedTurnRunner;
  human: string;
  room: RoomWithRoster;
  ana: string;
  nova: string;
}

/**
 * A channel with Ana and Nova in it, both on the seeded `engaged` mode.
 *
 * @param opts.responseGate - The setting under test; defaults to the shipped one.
 * @param opts.perRoom - The hourly ceiling, for the case about spending it.
 */
function open(opts: { responseGate?: ResponseGateMode; perRoom?: number } = {}): Wired {
  const runner = scriptedRunner(() => 'on it');
  const harness = createRoomHarness({
    agents: AGENTS,
    runner,
    ...(opts.responseGate ? { responseGate: opts.responseGate } : {}),
    ...(opts.perRoom !== undefined ? { maxAutomaticTurnsPerRoomPerHour: opts.perRoom } : {}),
  });
  const room = harness.service.createRoom(
    {
      kind: 'channel',
      title: 'Backend',
      members: [],
      agentPaths: ['/agents/ana', '/agents/nova'],
    },
    harness.human
  );
  return {
    db: harness.db,
    service: harness.service,
    store: harness.store,
    runner,
    human: harness.human,
    room,
    ana: harness.authors.resolveAgent('/agents/ana', 'ana').id,
    nova: harness.authors.resolveAgent('/agents/nova', 'nova').id,
  };
}

/** One message from the person, settled. */
async function say(w: Wired, text: string): Promise<RoomEntry> {
  const entry = w.service.post(w.room.id, { authorId: w.human, text });
  await w.service.triggersIdle();
  return entry;
}

/** How many turns one agent has been asked for. */
function turnsFor(w: Wired, authorId: string): number {
  return w.runner.turns.filter((turn) => turn.authorId === authorId).length;
}

/**
 * Engage Ana, then get Nova talking — the state every gate case starts from.
 *
 * Ana is inside her window and nobody has named her since, so every message
 * below reaches her as an overheard one.
 */
async function engageAna(w: Wired): Promise<void> {
  await say(w, '@ana is the build green?');
  expect(turnsFor(w, w.ana)).toBe(1);
  w.runner.turns.length = 0;
}

beforeEach(() => {
  resetDispatchBuffers();
  vi.restoreAllMocks();
});

describe('a message that named somebody else', () => {
  it('T1 — runs no turn for the agent that only overheard it', async () => {
    const w = open();
    await engageAna(w);
    await say(w, '@nova can you ship the release?');
    // Nova was asked. Ana was not, and until now paid a full model turn to work
    // that out (`meta/agent-etiquette.md` E7).
    expect(turnsFor(w, w.nova)).toBe(1);
    expect(turnsFor(w, w.ana)).toBe(0);
  });

  it('T2 — writes nothing into the room', async () => {
    const w = open();
    await engageAna(w);
    const before = w.service.listEntries(w.room.id, w.human, { limit: 200 }).length;
    await say(w, '@nova can you ship the release?');
    const after = w.service.listEntries(w.room.id, w.human, { limit: 200 });
    // The person's message and Nova's reply. No notice about Ana: nobody asked
    // her, so there is no obligation to discharge, and a line per overheard
    // message is the over-participation the whole domain damps.
    expect(after.length - before).toBe(2);
    expect(after.some((entry) => entry.kind === 'notice')).toBe(false);
  });

  it('T3 — leaves the message unread, so it is background on the next turn', async () => {
    const w = open();
    await engageAna(w);
    const cursorBefore = w.store.getMember(w.room.id, w.ana)?.lastReadSeq ?? 0;
    const skipped = await say(w, '@nova can you ship the release?');
    expect(w.store.getMember(w.room.id, w.ana)?.lastReadSeq).toBe(cursorBefore);

    // And it really does reach her — a skipped message is ambient, not lost.
    w.runner.turns.length = 0;
    await say(w, '@ana what did you make of that?');
    const [turn] = w.runner.turns.filter((each) => each.authorId === w.ana);
    expect(turn).toBeDefined();
    expect(turn!.roomContext.pending.some((entry) => entry.id === skipped.id)).toBe(true);
  });
});

describe('T4 — a skipped message never counts against a turn limit', () => {
  it('spends no budget, stamps no dispatch, and adds nothing to the cascade', async () => {
    const w = open({ perRoom: 100 });
    await engageAna(w);
    // Nova is silenced so that the ONLY turn any of this could buy is Ana's.
    // With Nova answering, her own spend would sit in every number below and
    // the invariant would be measured through a second agent's behaviour.
    w.service.updateMembership(w.room.id, w.human, w.nova, 'silent');
    await say(w, '@ana one more thing');
    // The room's headroom as the LAST turn was told it — the number an agent
    // decides how freely to answer against.
    const before = w.runner.turns.at(-1)!.roomContext.budget
      .automaticRepliesLeftInThisRoomThisHour;
    const spendBefore = w.db.select().from(roomTurnSpend).all().length;

    const skipped = await say(w, '@nova can you ship the release?');

    // NOTHING was charged. `tryReserve` is downstream of the gate and has no
    // counterpart, so a turn that is never reserved is the only kind that can
    // cost nothing — a refund was explicitly declined in `room-trigger.ts`.
    expect(w.db.select().from(roomTurnSpend).all().length - spendBefore).toBe(0);
    // No dispatch id was minted for Ana, so the turn-scoped repeat counter
    // (DOR-1434) counted nothing in this chain either.
    expect(
      w.store.turnsByAuthorInCascade(w.room.id, skipped.cascadeRoot).get(w.ana)
    ).toBeUndefined();

    await say(w, '@ana and now?');
    const after = w.runner.turns.at(-1)!.roomContext.budget
      .automaticRepliesLeftInThisRoomThisHour;
    // One spend between the two readings — Ana's own turn here. Without the gate
    // it would be two, and the overheard message would have bought the second.
    expect(before! - after!).toBe(1);
  });

  it('cannot exhaust a room ceiling, so a direct question still gets answered', async () => {
    const w = open({ perRoom: 5 });
    await engageAna(w);
    // Nova is silenced, so the ONLY thing these fifty messages could buy is
    // Ana's overhearing. Without that, Nova's own answers would spend the
    // ceiling and the case would prove nothing about the gate.
    w.service.updateMembership(w.room.id, w.human, w.nova, 'silent');
    // Fifty messages that all named Nova. Under the old behaviour each one bought
    // Ana a turn as well, and the ceiling was gone inside three of them — the
    // failure this ticket exists to prevent, made worse by DOR-1434 raising the
    // ceilings that used to be the accidental brake.
    for (let i = 0; i < 50; i += 1) {
      w.service.post(w.room.id, { authorId: w.human, text: `@nova item ${i}` });
      await w.service.triggersIdle();
    }
    expect(turnsFor(w, w.ana)).toBe(0);

    w.runner.turns.length = 0;
    await say(w, '@ana are you still there?');
    expect(turnsFor(w, w.ana)).toBe(1);
  });
});

describe('T6 — an addressed trigger is never gated', () => {
  it('answers a message that named this agent as well as another', async () => {
    const w = open();
    await engageAna(w);
    await say(w, '@nova @ana one of you please');
    expect(turnsFor(w, w.ana)).toBe(1);
  });

  it('answers everything in a DM, where naming is implicit', async () => {
    const runner = scriptedRunner(() => 'on it');
    const harness = createRoomHarness({ agents: AGENTS, runner });
    const dm = harness.service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana', '/agents/nova'] },
      harness.human
    );
    const ana = harness.authors.resolveAgent('/agents/ana', 'ana').id;
    // Names Nova, in a DM. Ana is addressed anyway, because outside a channel a
    // person's message addresses whoever is there.
    harness.service.post(dm.id, { authorId: harness.human, text: '@nova ship it' });
    await harness.service.triggersIdle();
    expect(runner.turns.filter((turn) => turn.authorId === ana).length).toBe(1);
  });

  it('answers a burst that mixed one addressed message with overheard ones', async () => {
    const w = open();
    await engageAna(w);
    // Posted inside one collect window, so they become ONE turn. A single
    // `mention` anywhere in it makes the whole burst addressed.
    w.service.post(w.room.id, { authorId: w.human, text: '@nova ship the release' });
    w.service.post(w.room.id, { authorId: w.human, text: '@ana and check the migration' });
    await w.service.triggersIdle();
    expect(turnsFor(w, w.ana)).toBe(1);
  });
});

describe('T7 — modes the gate does not reach', () => {
  it('leaves an `always` member answering everything', async () => {
    const w = open();
    w.service.updateMembership(w.room.id, w.human, w.ana, 'always');
    await say(w, '@nova can you ship the release?');
    // `always` means always. Widening the gate to it is deferred (spec §12 F3)
    // precisely because a false skip there makes an agent mute to its owner.
    expect(turnsFor(w, w.ana)).toBe(1);
  });

  it('leaves an agent that was never engaged exactly as it was — silent', async () => {
    const w = open();
    await say(w, '@nova can you ship the release?');
    // Not gated, just not selected. The distinction matters for the audit: a
    // refusal is only written when the gate actually declined something.
    expect(turnsFor(w, w.ana)).toBe(0);
    expect(recentRefusals().some((entry) => entry.reason === 'not_addressed_to_me')).toBe(false);
  });
});

describe('the switch', () => {
  it('runs the full turn again when the gate is off', async () => {
    const w = open({ responseGate: 'off' });
    await engageAna(w);
    await say(w, '@nova can you ship the release?');
    // Bit-for-bit the behaviour that shipped before DOR-1203: Ana runs a whole
    // turn to decide she has nothing to add.
    expect(turnsFor(w, w.ana)).toBe(1);
  });
});

describe('T12 — the audit trail', () => {
  it('records one refusal per skip, correlated, at info', async () => {
    const w = open();
    await engageAna(w);
    const info = vi.spyOn(logger, 'info');
    const skipped = await say(w, '@nova can you ship the release?');

    // TWO skips, and the second is the point of R2. Nova ANSWERS, and her reply
    // reaches Ana as another overheard message — the shape that used to double
    // the bill for every bystander in a channel, and that DOR-1434's ten-deep
    // cascades multiply.
    const skips = recentRefusals().filter((entry) => entry.reason === 'not_addressed_to_me');
    expect(skips).toHaveLength(2);
    // Newest first, which is how the ring answers every question put to it.
    expect(skips.at(-1)).toMatchObject({
      reason: 'not_addressed_to_me',
      // `chosen`, not `silent`: the agent decided this and nobody was waiting to
      // be told, so it logs at `info` and does not drown the refusals that are
      // the only record of something going wrong.
      visibility: 'chosen',
      roomId: w.room.id,
      authorId: w.ana,
      entryId: skipped.id,
    });
    // Explicitly no dispatch, and never the ambient one: nothing was claimed for
    // Ana, and this sweep may be running inside Nova's scope.
    expect(skips.at(-1)!.dispatchId).toBeUndefined();

    // WHICH rule lives on the log line rather than in the ring, because the ring
    // is served without a credential while login is off and therefore carries
    // ids only (`dispatch-buffers.ts`). The log is the durable tuning surface:
    // `jq 'select(.reason=="not_addressed_to_me") | .rule'`.
    const logged = info.mock.calls.filter(
      ([, fields]) => (fields as { reason?: string } | undefined)?.reason === 'not_addressed_to_me'
    );
    expect(logged.map(([, fields]) => (fields as { rule?: string }).rule)).toEqual([
      'named_other_agent',
      'colleagues_answer',
    ]);
    expect(logged[0]![1]).toMatchObject({ tier: 1, entries: 1, visibility: 'chosen' });
  });

  it('writes no refusal for a turn that ran', async () => {
    const w = open();
    await engageAna(w);
    await say(w, '@ana one more thing');
    expect(recentRefusals().some((entry) => entry.reason === 'not_addressed_to_me')).toBe(false);
  });
});
