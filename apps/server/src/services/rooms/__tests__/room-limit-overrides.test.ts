/**
 * A room's own automatic-reply limits, measured through the real service, the
 * real dispatcher and the real budget (DOR-1429).
 *
 * `room-limits.test.ts` proves the ladder resolves the right numbers.
 * **This file proves the numbers reach the things that stop a conversation** —
 * which is the half a pure-function test cannot see, and the half that was
 * wrong every previous time a limit was threaded through this domain.
 *
 * The harness supplies the CONFIG rung; every override here is written onto the
 * room through `RoomService.updateRoom`, exactly as the API writes one.
 */
import { describe, it, expect } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

/** Everything one scenario is driven through. */
interface Wired {
  service: RoomService;
  authors: AuthorRegistry;
  runner: ScriptedTurnRunner;
  room: RoomWithRoster;
  human: string;
}

/**
 * A two-agent channel where both answer everything and every answer is a post —
 * so one human message starts a cascade that runs until something stops it.
 *
 * @param opts - The CONFIG rung, i.e. what Settings says install-wide.
 */
function openLoudRoom(
  opts: Parameters<typeof createRoomHarness>[0] = { agents: AGENTS },
  /**
   * How many turns keep the ball in the air before the agents fall silent.
   *
   * Unbounded by default, because a bounded conversation is exactly what most
   * of these tests are measuring. **A test of an UNLIMITED room must pass a
   * number**: with this room's limits off nothing in DorkOS ends the exchange,
   * which is the documented state (`plans/room-turn-limits-overhaul.md` risk 2)
   * and, in a test, an infinite loop. Agents that run out of things to say are
   * the honest stand-in for the person who would otherwise press Stop.
   */
  talkativeTurns = Number.POSITIVE_INFINITY
): Wired {
  let spoken = 0;
  const harness = createRoomHarness({
    ...opts,
    agents: AGENTS,
    // Every turn produces a post, which re-enters the room and triggers the
    // other agent. A runner that answered `null` could never reach a repeat
    // rule, because there would be no repeats.
    runner: scriptedRunner(() => (++spoken <= talkativeTurns ? 'ack' : null)),
  });
  const { service, authors, runner, human } = harness;
  const room = service.createRoom(
    { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
    human
  );
  for (const path of ['/agents/ana', '/agents/bo']) {
    service.updateMembership(room.id, human, authors.resolveAgent(path, path).id, 'always');
  }
  return { service, authors, runner, room, human };
}

/** Post as the person and wait for everything it set off. */
async function seed(wired: Wired): Promise<void> {
  wired.service.post(wired.room.id, { authorId: wired.human, text: 'go' });
  await wired.service.triggersIdle();
}

/** The room's notices, in its own voice. */
function notices(wired: Wired): RoomEntry[] {
  return wired.service
    .listEntries(wired.room.id, wired.human, { limit: 500 })
    .filter((entry) => entry.kind === 'notice');
}

describe('a room override changes where a cascade stops', () => {
  it('stops sooner than the install would', async () => {
    // Install-wide: ten turns per agent per cascade. This room: one.
    const wired = openLoudRoom({ agents: AGENTS, maxTurnsPerAgentPerCascade: 10 });
    wired.service.updateRoom(wired.room.id, wired.human, { maxTurnsPerAgentPerCascade: 1 });
    await seed(wired);

    // One turn each, then the repeat rule fires — and it is announced, so the
    // room did not simply go quiet.
    expect(wired.runner.turns).toHaveLength(2);
    expect(notices(wired).map((n) => n.body.notice)).toContain('cascade_stopped');
  });

  it('runs further than the same install would without the override', async () => {
    // The control for the test above. Same config, same script, no override —
    // so any difference between the two is the override and nothing else.
    const wired = openLoudRoom({ agents: AGENTS, maxTurnsPerAgentPerCascade: 10 });
    await seed(wired);
    expect(wired.runner.turns.length).toBeGreaterThan(2);
  });

  it('lets a room run LONGER than the install allows, not only shorter', async () => {
    const tight = openLoudRoom({ agents: AGENTS, maxTurnsPerAgentPerCascade: 1 });
    await seed(tight);
    const withInstallLimit = tight.runner.turns.length;

    const loose = openLoudRoom({ agents: AGENTS, maxTurnsPerAgentPerCascade: 1 });
    loose.service.updateRoom(loose.room.id, loose.human, { maxTurnsPerAgentPerCascade: 3 });
    await seed(loose);

    expect(loose.runner.turns.length).toBeGreaterThan(withInstallLimit);
  });

  it('goes back to the install when the override is cleared', async () => {
    const wired = openLoudRoom({ agents: AGENTS, maxTurnsPerAgentPerCascade: 1 });
    wired.service.updateRoom(wired.room.id, wired.human, { maxTurnsPerAgentPerCascade: 3 });
    // Cleared with an explicit null, which is what the API sends for "use the
    // default again".
    wired.service.updateRoom(wired.room.id, wired.human, { maxTurnsPerAgentPerCascade: null });
    await seed(wired);

    // Back to one turn each, exactly as a room that never had an override.
    expect(wired.runner.turns).toHaveLength(2);
  });
});

describe('the per-room toggle, and the one thing it does not switch off', () => {
  it('makes a room unlimited on an install that limits every other room', async () => {
    const wired = openLoudRoom(
      {
        agents: AGENTS,
        turnLimitsEnabled: true,
        maxTurnsPerAgentPerCascade: 1,
        // High enough that the hourly caps cannot be what stops this.
        maxAutomaticTurnsPerRoomPerHour: 1_000,
        maxAutomaticTurnsTotalPerHour: 1_000,
        maxAgentDepth: 30,
      },
      // Nothing in an unlimited room stops a cascade, so the agents stop
      // themselves after six answers.
      6
    );
    wired.service.updateRoom(wired.room.id, wired.human, { turnLimitsEnabled: false });
    await seed(wired);

    // Well past the one-turn-per-agent the install would have allowed, and not
    // a single refusal notice: nothing was refused, so nothing was said.
    expect(wired.runner.turns.length).toBeGreaterThan(2);
    expect(notices(wired)).toHaveLength(0);
  });

  it('still charges an unlimited room against the install hourly total', async () => {
    // **The asymmetry, end to end.** A room opts out of its own bounds, never
    // out of the install's wallet — so the global cap of 2 holds even though
    // this room's own limits are off.
    const wired = openLoudRoom({
      agents: AGENTS,
      turnLimitsEnabled: true,
      maxAgentDepth: 30,
      maxTurnsPerAgentPerCascade: 10,
      maxAutomaticTurnsPerRoomPerHour: 1_000,
      maxAutomaticTurnsTotalPerHour: 2,
    });
    wired.service.updateRoom(wired.room.id, wired.human, { turnLimitsEnabled: false });
    await seed(wired);

    expect(wired.runner.turns).toHaveLength(2);
    const budgetNotices = notices(wired).filter((n) => n.body.notice === 'budget_reached');
    expect(budgetNotices).toHaveLength(1);
  });

  it('keeps a room limited when the install turned limits off', async () => {
    const wired = openLoudRoom({
      agents: AGENTS,
      turnLimitsEnabled: false,
      maxTurnsPerAgentPerCascade: 1,
      maxAutomaticTurnsTotalPerHour: 1_000,
    });
    wired.service.updateRoom(wired.room.id, wired.human, { turnLimitsEnabled: true });
    await seed(wired);

    // The room's own bounds are back on, at the install's numbers, even though
    // the install itself is counting nothing.
    expect(wired.runner.turns).toHaveLength(2);
    expect(notices(wired).map((n) => n.body.notice)).toContain('cascade_stopped');
  });
});

describe('what an unlimited room tells the agent about its headroom', () => {
  it('reports no limit for its own bounds and a real number for the install', async () => {
    const wired = openLoudRoom(
      {
        agents: AGENTS,
        turnLimitsEnabled: true,
        maxTurnsPerAgentPerCascade: 1,
        maxAutomaticTurnsPerRoomPerHour: 50,
        maxAutomaticTurnsTotalPerHour: 60,
        maxAgentDepth: 30,
      },
      4
    );
    wired.service.updateRoom(wired.room.id, wired.human, { turnLimitsEnabled: false });
    await seed(wired);

    const budget = wired.runner.turns[0]?.roomContext?.budget;
    expect(budget).toBeDefined();
    // The room's two bounds are gone; the install's hour is still counting, and
    // saying otherwise would tell the agent nothing is watching when something
    // is.
    expect(budget?.automaticRepliesLeftInThisRoomThisHour).toBeNull();
    expect(budget?.repliesLeftInThisChain).toBeNull();
    expect(budget?.automaticRepliesLeftInTotalThisHour).toEqual(expect.any(Number));
  });

  it('reports three numbers in an ordinary room', async () => {
    const wired = openLoudRoom({
      agents: AGENTS,
      maxTurnsPerAgentPerCascade: 1,
      maxAutomaticTurnsPerRoomPerHour: 50,
      maxAutomaticTurnsTotalPerHour: 60,
    });
    await seed(wired);

    const budget = wired.runner.turns[0]?.roomContext?.budget;
    expect(budget?.automaticRepliesLeftInThisRoomThisHour).toEqual(expect.any(Number));
    expect(budget?.automaticRepliesLeftInTotalThisHour).toEqual(expect.any(Number));
    expect(budget?.repliesLeftInThisChain).toEqual(expect.any(Number));
  });

  it('spends this room hourly override, not the install one', async () => {
    const wired = openLoudRoom({
      agents: AGENTS,
      maxTurnsPerAgentPerCascade: 10,
      maxAgentDepth: 30,
      maxAutomaticTurnsPerRoomPerHour: 1_000,
      maxAutomaticTurnsTotalPerHour: 1_000,
    });
    wired.service.updateRoom(wired.room.id, wired.human, { maxAutoTurnsPerHour: 2 });
    await seed(wired);

    expect(wired.runner.turns).toHaveLength(2);
    expect(notices(wired).map((n) => n.body.notice)).toContain('budget_reached');
  });
});

describe('who may set a room limit', () => {
  it('refuses an agent, and leaves the room untouched', () => {
    const wired = openLoudRoom({ agents: AGENTS });
    const ana = wired.authors.resolveAgent('/agents/ana', 'Ana').id;
    expect(() => wired.service.updateRoom(wired.room.id, ana, { maxAgentDepth: 99 })).toThrowError(
      /Only people/
    );
    expect(wired.service.getRoom(wired.room.id, wired.human)?.maxAgentDepth).toBeNull();
  });

  it('lets the same agent patch a topic, so the gate is the fields', () => {
    const wired = openLoudRoom({ agents: AGENTS });
    const ana = wired.authors.resolveAgent('/agents/ana', 'Ana').id;
    expect(wired.service.updateRoom(wired.room.id, ana, { topic: 'the API' }).topic).toBe(
      'the API'
    );
  });
});
