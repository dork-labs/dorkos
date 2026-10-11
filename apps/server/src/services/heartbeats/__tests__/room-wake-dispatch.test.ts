/**
 * The room hook for event wakes, through the real rooms service and trigger
 * dispatcher (spec `heartbeats` §3.3, PR 3 review round 2): a turn the room's
 * spending budget refused wakes the agent's beat for a person's message, and
 * never for an agent's post made outside its own room turn — the shape of
 * every beat post, so two beats can never wake each other in a loop.
 *
 * The room is unlimited on an install whose hourly total is spent, so the
 * cascade guard never refuses and the budget is the only thing that does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventWakes } from '../event-wakes.js';
import type { BeatWake } from '../beat-runner.js';
import type { BeatClock } from '../beat-scheduler.js';
import { agentLookupFor, createRoomHarness } from '../../rooms/__tests__/room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana' },
  '/agents/bo': { name: 'bo' },
});

/** A clock whose timers fire only when the test says so. */
function manualClock(): BeatClock & { fireAll(): void } {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    now: () => Date.now(),
    setTimeout: (fn) => {
      next += 1;
      timers.set(next, fn);
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    fireAll: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
  };
}

let hub: EventWakes | undefined;

afterEach(() => hub?.uninstall());

/** A channel with Ana and Bo, its own limits off, on an install out of budget. */
function open(opts: { leadAgentPath?: string } = {}) {
  const harness = createRoomHarness({ agents: AGENTS, maxAutomaticTurnsTotalPerHour: 0 });
  const room = harness.service.createRoom(
    {
      kind: 'channel',
      title: 'Ops',
      members: [],
      agentPaths: ['/agents/ana', '/agents/bo'],
      ...(opts.leadAgentPath ? { leadAgentPath: opts.leadAgentPath } : {}),
    },
    harness.human
  );
  harness.service.updateRoom(room.id, harness.human, { turnLimitsEnabled: false });
  const clock = manualClock();
  const beats: Array<{ agentId: string; wake: BeatWake }> = [];
  hub = new EventWakes({
    clock,
    localDay: () => '2026-10-12',
    beat: (agentId, wake) => beats.push({ agentId, wake }),
    agentIdAt: (path) => ({ '/agents/ana': 'agent-ana', '/agents/bo': 'agent-bo' })[path],
    agentsForConnection: () => [],
    noteNewManager: () => undefined,
    refresh: () => undefined,
  });
  hub.install();
  const ana = harness.authors.resolveAgent('/agents/ana', 'ana').id;
  const bo = harness.authors.resolveAgent('/agents/bo', 'bo').id;
  return {
    ...harness,
    room,
    bo,
    ana,
    /** Post, let the room settle, and fire the wake windows. */
    async say(authorId: string, text: string): Promise<string[]> {
      harness.service.post(room.id, { authorId, text });
      await harness.service.triggersIdle();
      clock.fireAll();
      return beats.map((beat) => beat.agentId);
    },
  };
}

describe('a turn the room budget refused', () => {
  it("wakes the agent a person's message named", async () => {
    const room = open();
    expect(await room.say(room.human, '@ana can you check the invoices?')).toEqual(['agent-ana']);
    expect(room.runner.turns).toHaveLength(0);
  });

  it("never wakes for an agent's post made outside its own room turn", async () => {
    const room = open();
    // What a beat's post looks like to the room: Bo's, with no room turn behind it.
    expect(await room.say(room.bo, '@ana the build is red again')).toEqual([]);
  });

  it('wakes the channel lead for a person’s post nobody else is answering', async () => {
    const room = open({ leadAgentPath: '/agents/ana' });
    expect(await room.say(room.human, 'Is anyone around to look at the invoices?')).toEqual([
      'agent-ana',
    ]);
  });
});
