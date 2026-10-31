/**
 * The work queue loop (DOR-3462): items run in order under the target, nothing
 * starts at a limit and it resumes when the limit clears, and a restart never
 * starts an item twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentWorkItemRow, Db } from '@dorkos/db';
import type { WorkQueueHold } from '@dorkos/shared/work-queue-schemas';
import {
  WorkQueueRunner,
  type ChatState,
  type StartResult,
  type WorkQueueRunnerDeps,
} from '../work-queue-runner.js';
import { WorkQueueService } from '../work-queue-service.js';
import { WorkQueueStore } from '../work-queue-store.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: () => ({}),
}));

const ANA = 'agent-ana';
const BO = 'agent-bo';
const DAY = '2026-10-30';

/** The fake world one test runs against. */
interface World {
  machine: WorkQueueHold | null;
  capFull: boolean;
  mayStart: boolean;
  leader: boolean;
  /** What the next start answers, or a thrown error. */
  nextStart: StartResult | Error | null;
  /** Every item a chat was started for, in order. */
  started: string[];
  chats: Map<string, ChatState>;
  /** The time now. */
  today: string;
}

describe('WorkQueueRunner', () => {
  let db: Db;
  let store: WorkQueueStore;
  let service: WorkQueueService;
  let world: World;

  /** A runner over the shared world, as a fresh process would build one. */
  function newRunner(): WorkQueueRunner {
    const deps: WorkQueueRunnerDeps = {
      store,
      isLeader: () => world.leader,
      machineHold: async () => world.machine,
      chatCapFull: () => world.capFull,
      agentOf: (agentId) =>
        agentId === 'agent-gone'
          ? undefined
          : { agentId, agentPath: `/agents/${agentId}`, label: agentId },
      mayStartChat: async () => world.mayStart,
      startChat: async (_agent, item: AgentWorkItemRow) => {
        const next = world.nextStart;
        world.nextStart = null;
        if (next instanceof Error) {
          world.started.push(item.title);
          throw next;
        }
        if (next) return next;
        world.started.push(item.title);
        const sessionId = `chat-${item.title}`;
        world.chats.set(sessionId, { kind: 'live' });
        return { kind: 'started', sessionId, accountId: 'acct-1' };
      },
      chatState: async (item) =>
        world.chats.get(item.sessionId as string) ?? { kind: 'ended', outcome: 'finished' },
      now: () => new Date(world.today),
    };
    return new WorkQueueRunner(deps);
  }

  /** Queue an item as the agent. */
  function add(agentId: string, title: string) {
    return service.add({ kind: 'agent', agentId }, agentId, { title, prompt: `Do ${title}` });
  }

  /** Finish a running chat. */
  function finish(title: string, state: ChatState = { kind: 'ended', outcome: 'finished' }) {
    world.chats.set(`chat-${title}`, state);
  }

  beforeEach(() => {
    db = createTestDb();
    store = new WorkQueueStore(db);
    // The service reads the same fake clock as the runner. Without it,
    // `startsToday` counted against the real date and went red on 2026-10-31.
    service = new WorkQueueService({
      store,
      holdOf: () => null,
      wake: () => undefined,
      now: () => new Date(world.today),
    });
    world = {
      machine: null,
      capFull: false,
      mayStart: true,
      leader: true,
      nextStart: null,
      started: [],
      chats: new Map(),
      today: '2026-10-30T12:00:00.000Z',
    };
    // Off by default: every test but the one about that turns its queues on.
    for (const agentId of [ANA, BO, 'agent-gone']) service.update(agentId, { enabled: true });
  });

  it('starts nothing for an agent nobody turned on', async () => {
    const carol = 'agent-carol';
    add(carol, 'first');
    await newRunner().pass();
    expect(world.started).toEqual([]);
    expect(service.read(carol).enabled).toBe(false);

    service.update(carol, { enabled: true });
    await newRunner().pass();
    expect(world.started).toEqual(['first']);
  });

  it('stops at the daily start cap, and counts again the next day', async () => {
    service.update(ANA, { dailyStartCap: 1 });
    add(ANA, 'first');
    add(ANA, 'second');
    const runner = newRunner();
    await runner.pass();
    finish('first');

    await runner.pass();
    expect(world.started).toEqual(['first']);
    expect(runner.holdOf(ANA)).toBe('daily-cap');
    expect(service.read(ANA).startsToday).toBe(1);

    world.today = '2026-10-31T00:00:01.000Z';
    await runner.pass();
    expect(world.started).toEqual(['first', 'second']);
  });

  it('counts a start that threw, but not one that never happened', async () => {
    add(ANA, 'held');
    add(ANA, 'refused');
    add(ANA, 'threw');
    const runner = newRunner();

    world.nextStart = { kind: 'held', hold: 'accounts' };
    await runner.pass();
    expect(service.read(ANA).startsToday).toBe(0);

    world.nextStart = { kind: 'refused', message: 'No.' };
    await runner.pass();
    expect(service.read(ANA).startsToday).toBe(0);

    world.nextStart = new Error('boom');
    await runner.pass();
    expect(service.read(ANA).startsToday).toBe(1);
  });

  it('one stop halts every queue, and lifting it resumes them', async () => {
    add(ANA, 'first');
    add(BO, 'second');
    service.setAllStopped(true);
    const runner = newRunner();

    await runner.pass();
    expect(world.started).toEqual([]);
    expect(runner.holdOf(ANA)).toBe('stopped');
    expect(runner.holdOf(BO)).toBe('stopped');

    service.setAllStopped(false);
    await runner.pass();
    expect(world.started).toHaveLength(1);
  });

  it('a chat waiting on an approval card keeps its slot', async () => {
    add(ANA, 'first');
    add(ANA, 'second');
    const runner = newRunner();
    await runner.pass();

    // `chatState` answers live for a blocked chat; see the wiring's own test.
    await runner.pass();
    await runner.pass();
    expect(world.started).toEqual(['first']);
  });

  it('runs a queue of two with a target of one, in order', async () => {
    add(ANA, 'first');
    add(ANA, 'second');
    const runner = newRunner();

    await runner.pass();
    expect(world.started).toEqual(['first']);

    await runner.pass();
    expect(world.started).toEqual(['first']);

    finish('first');
    await runner.pass();
    expect(world.started).toEqual(['first', 'second']);

    const queue = service.read(ANA);
    expect(queue.items.map((i) => [i.title, i.state])).toEqual([['second', 'running']]);
    expect(queue.recent.map((i) => [i.title, i.outcome])).toEqual([['first', 'finished']]);
    expect(queue.items[0]?.accountId).toBe('acct-1');
  });

  it('starts at most one chat per pass, up to the target', async () => {
    add(ANA, 'first');
    add(ANA, 'second');
    add(ANA, 'third');
    service.update(ANA, { target: 2 });
    const runner = newRunner();

    await runner.pass();
    expect(world.started).toEqual(['first']);
    await runner.pass();
    expect(world.started).toEqual(['first', 'second']);
    await runner.pass();
    expect(world.started).toEqual(['first', 'second']);
  });

  it.each(['disk', 'load'] as const)(
    'starts nothing at the %s limit, then resumes',
    async (hold) => {
      add(ANA, 'first');
      world.machine = hold;
      const runner = newRunner();

      await runner.pass();
      expect(world.started).toEqual([]);
      expect(runner.holdOf(ANA)).toBe(hold);
      expect(service.read(ANA).items[0]?.state).toBe('queued');

      world.machine = null;
      await runner.pass();
      expect(world.started).toEqual(['first']);
      expect(runner.holdOf(ANA)).toBeNull();
    }
  );

  it('starts nothing at the chat cap, then resumes', async () => {
    add(ANA, 'first');
    world.capFull = true;
    const runner = newRunner();

    await runner.pass();
    expect(world.started).toEqual([]);
    expect(runner.holdOf(ANA)).toBe('chat-cap');

    world.capFull = false;
    await runner.pass();
    expect(world.started).toEqual(['first']);
  });

  it('keeps the item in line when every account is near its limit, then resumes', async () => {
    add(ANA, 'first');
    world.nextStart = { kind: 'held', hold: 'accounts' };
    const runner = newRunner();

    await runner.pass();
    expect(world.started).toEqual([]);
    expect(runner.holdOf(ANA)).toBe('accounts');
    expect(service.read(ANA).items[0]?.state).toBe('queued');

    await runner.pass();
    expect(world.started).toEqual(['first']);
  });

  it('holds an agent that may not start a chat unasked, without touching its item', async () => {
    add(ANA, 'first');
    world.mayStart = false;
    const runner = newRunner();

    await runner.pass();
    expect(world.started).toEqual([]);
    expect(runner.holdOf(ANA)).toBe('permission');
    expect(service.read(ANA).items[0]?.state).toBe('queued');
  });

  it('starts nothing for a queue turned off, and picks up when it is back on', async () => {
    add(ANA, 'first');
    service.update(ANA, { enabled: false });
    const runner = newRunner();

    await runner.pass();
    expect(world.started).toEqual([]);

    service.update(ANA, { enabled: true });
    await runner.pass();
    expect(world.started).toEqual(['first']);
  });

  it('follows a new order', async () => {
    const first = add(ANA, 'first');
    const second = add(ANA, 'second');
    service.reorder(ANA, [second.id, first.id]);

    await newRunner().pass();
    expect(world.started).toEqual(['second']);
  });

  it('never starts an item twice across a restart', async () => {
    add(ANA, 'first');
    add(ANA, 'second');
    await newRunner().pass();
    expect(world.started).toEqual(['first']);

    // A new process knows nothing about the chat the old one ran.
    await newRunner().pass();

    expect(world.started).toEqual(['first', 'second']);
    const queue = service.read(ANA);
    expect(queue.recent.map((i) => [i.title, i.outcome])).toEqual([['first', 'interrupted']]);
  });

  it('does not re-run an item claimed by a process that died before it started', async () => {
    const item = add(ANA, 'first');
    expect(store.claim(item, DAY)).toBe(true);

    await newRunner().pass();

    expect(world.started).toEqual([]);
    expect(service.read(ANA).recent[0]?.outcome).toBe('interrupted');
  });

  it('a claim has one winner', () => {
    const item = add(ANA, 'first');
    expect(store.claim(item, DAY)).toBe(true);
    expect(store.claim(item, DAY)).toBe(false);
  });

  it('never puts back an item whose start threw, since it may have started', async () => {
    add(ANA, 'first');
    world.nextStart = new Error('boom');
    const runner = newRunner();

    await runner.pass();
    await runner.pass();

    expect(world.started).toEqual(['first']);
    expect(service.read(ANA).recent[0]).toMatchObject({ outcome: 'failed', note: 'boom' });
  });

  it('ends an item a start refused, and moves on to the next', async () => {
    add(ANA, 'first');
    add(ANA, 'second');
    world.nextStart = { kind: 'refused', message: 'That folder belongs to another agent.' };
    const runner = newRunner();

    await runner.pass();
    expect(service.read(ANA).recent[0]).toMatchObject({
      outcome: 'failed',
      note: 'That folder belongs to another agent.',
    });

    await runner.pass();
    expect(world.started).toEqual(['second']);
  });

  it('a follower starts nothing and ends nothing', async () => {
    add(ANA, 'first');
    await newRunner().pass();
    world.leader = false;
    add(ANA, 'second');
    finish('first');

    await newRunner().pass();

    expect(world.started).toEqual(['first']);
    expect(service.read(ANA).items.find((i) => i.title === 'first')?.state).toBe('running');
  });

  it('holds an unregistered agent and still serves the others', async () => {
    add('agent-gone', 'lost');
    add(BO, 'found');
    const runner = newRunner();

    // One start per pass, so the second pass is the one that reaches the other queue.
    await runner.pass();
    await runner.pass();

    expect(world.started).toEqual(['found']);
    expect(runner.holdOf('agent-gone')).toBe('agent-missing');
  });

  it('an agent stopped at an account limit frees its slot', async () => {
    add(ANA, 'first');
    add(ANA, 'second');
    const runner = newRunner();
    await runner.pass();

    finish('first', { kind: 'ended', outcome: 'limit' });
    await runner.pass();

    expect(world.started).toEqual(['first', 'second']);
    expect(service.read(ANA).recent[0]?.outcome).toBe('limit');
  });

  it('a person can queue an ended item again, and it starts a new chat', async () => {
    const item = add(ANA, 'first');
    const runner = newRunner();
    await runner.pass();
    finish('first');
    await runner.pass();

    service.requeue(item.id);
    world.chats.delete('chat-first');
    await runner.pass();

    expect(world.started).toEqual(['first', 'first']);
  });
});
