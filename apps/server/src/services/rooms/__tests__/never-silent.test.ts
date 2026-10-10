/**
 * A person is never left in silence (DOR-2823).
 *
 * Four promises, driven through the real {@link RoomService} and dispatcher
 * with only the turn runner scripted:
 *
 * - **The receipt.** An agent picked to answer a person's message gets 👀 on
 *   it at once, and it comes off when that agent's turn ends.
 * - **Busy is a wait, not a drop.** A launch the runtime refuses as busy is
 *   tried again on its own, and the room's one line about it says so.
 * - **The reason, when nobody can answer.** A message that reached no agent
 *   because there was nobody to reach gets one quiet line, damped.
 * - **Out of usage says when.** A turn that failed on a usage limit names the
 *   time it resets instead of "ran into a problem".
 *
 * @module server/services/rooms/tests/never-silent
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomService } from '../room-service.js';
import { BUSY_RETRY_DELAYS_MS, RECEIPT_EMOJI } from '../room-trigger.js';
import {
  agentLookupFor,
  createRoomHarness,
  gatedRunner,
  outcomeRunner,
  scriptedRunner,
  speakingRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana' },
  '/agents/bo': { name: 'bo' },
});

afterEach(() => {
  vi.useRealTimers();
});

interface Wired {
  service: RoomService;
  human: string;
  room: RoomWithRoster;
  ana: string;
  bo: string;
}

function open(
  runner: ScriptedTurnRunner,
  opts: {
    agentPaths?: string[];
    usageLimitFor?: (sessionId: string) => { resetsAt: string | null } | null;
  } = {}
): Wired {
  const harness = createRoomHarness({
    agents: AGENTS,
    runner,
    ...(opts.usageLimitFor ? { usageLimitFor: opts.usageLimitFor } : {}),
  });
  const room = harness.service.createRoom(
    {
      kind: 'channel',
      title: 'Poster',
      members: [],
      agentPaths: opts.agentPaths ?? ['/agents/ana', '/agents/bo'],
    },
    harness.human
  );
  return {
    service: harness.service,
    human: harness.human,
    room,
    ana: harness.authors.resolveAgent('/agents/ana', 'ana').id,
    bo: harness.authors.resolveAgent('/agents/bo', 'bo').id,
  };
}

function receiptsOn(w: Wired, entry: RoomEntry): string[] {
  return w.service
    .reactionsFor(w.room.id, entry.id)
    .filter((r) => r.emoji === RECEIPT_EMOJI)
    .flatMap((r) => r.authorIds ?? []);
}

function notices(w: Wired): string[] {
  return w.service
    .listEntries(w.room.id, w.human, { limit: 200 })
    .filter((e) => e.kind === 'notice')
    .map((e) => e.body.text);
}

describe('the 👀 receipt', () => {
  it('goes on the moment an agent is picked, and comes off when its turn ends', async () => {
    const runner = gatedRunner();
    const w = open(runner);
    const asked = w.service.post(w.room.id, { authorId: w.human, text: '@ana what is next?' });
    expect(receiptsOn(w, asked)).toEqual([w.ana]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.holdsFor(w.ana)).toBe(1);
    expect(receiptsOn(w, asked)).toEqual([w.ana]);

    runner.releaseAll();
    await w.service.triggersIdle();
    expect(receiptsOn(w, asked)).toEqual([]);
  });

  it('is never put on an agent’s message', async () => {
    const w = open(scriptedRunner(() => null));
    const said = w.service.post(w.room.id, { authorId: w.bo, text: '@ana deploy is out' });
    await w.service.triggersIdle();
    expect(receiptsOn(w, said)).toEqual([]);
  });
});

describe('a busy agent is tried again', () => {
  it('answers once it is free, and says so once while it waits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const runner = speakingRunner(() => {
      calls += 1;
      return calls === 1 ? { text: null, unanswered: 'busy' } : { text: 'done' };
    });
    const w = open(runner, { agentPaths: ['/agents/ana'] });
    w.service.post(w.room.id, { authorId: w.human, text: '@ana what is next?' });
    await w.service.triggersIdle();
    expect(calls).toBe(1);
    expect(notices(w)).toEqual([
      expect.stringContaining("is busy in its own chat. It will answer here when it's free."),
    ]);

    await vi.advanceTimersByTimeAsync(BUSY_RETRY_DELAYS_MS[0]! + 1_000);
    await w.service.triggersIdle();
    expect(calls).toBe(2);
    expect(notices(w)).toHaveLength(1);
  });

  it('stops after its last try, and says so honestly', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runner = outcomeRunner(() => ({ text: null, unanswered: 'busy' }));
    const w = open(runner, { agentPaths: ['/agents/ana'] });
    w.service.post(w.room.id, { authorId: w.human, text: '@ana what is next?' });
    await w.service.triggersIdle();
    for (const delay of BUSY_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay + 1_000);
      await w.service.triggersIdle();
    }
    expect(runner.turns).toHaveLength(BUSY_RETRY_DELAYS_MS.length + 1);
    expect(notices(w).at(-1)).toContain('stayed busy for two hours');
  });
});

describe('when nobody can answer', () => {
  it('says the channel has no lead, once', async () => {
    const w = open(scriptedRunner(() => null));
    w.service.updateRoom(w.room.id, w.human, { leadAuthorId: null });
    w.service.post(w.room.id, { authorId: w.human, text: 'what is next?' });
    await w.service.triggersIdle();
    w.service.post(w.room.id, { authorId: w.human, text: 'anyone?' });
    await w.service.triggersIdle();
    expect(notices(w)).toEqual([
      'Nobody answered: this channel has no lead. @mention an agent, or pick a lead.',
    ]);
  });

  it('says the channel has no agents', async () => {
    const w = open(
      scriptedRunner(() => null),
      { agentPaths: [] }
    );
    w.service.post(w.room.id, { authorId: w.human, text: 'hello?' });
    await w.service.triggersIdle();
    expect(notices(w)).toEqual([
      'No agent is in this channel to answer. Add one to get answers here.',
    ]);
  });

  it('says nothing when the message was for somebody', async () => {
    const w = open(scriptedRunner(() => 'on it'));
    w.service.post(w.room.id, { authorId: w.human, text: '@ana what is next?' });
    await w.service.triggersIdle();
    expect(notices(w)).toEqual([]);
  });
});

describe('out of usage', () => {
  it('says when the agent can answer again', async () => {
    const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const runner = outcomeRunner(() => ({ text: null, unanswered: 'failed' }));
    const w = open(runner, { agentPaths: ['/agents/ana'], usageLimitFor: () => ({ resetsAt }) });
    w.service.post(w.room.id, { authorId: w.human, text: '@ana what is next?' });
    await w.service.triggersIdle();
    const line = notices(w).at(-1) ?? '';
    expect(line).toContain('is out of usage until ');
    expect(line).not.toContain('ran into a problem');
  });
});
