/**
 * DOR-791: an agent turn the bus started knows which envelope it is answering,
 * so the messages it sends continue that budget instead of minting a fresh one.
 *
 * The registry half is unit-tested here; the half that matters — that the
 * dispatching adapter actually binds it FOR THE DURATION OF THE TURN, and
 * releases it however the turn ends — is driven through the real
 * ClaudeCodeAdapter, because a binding that exists only after the turn is over
 * is worth nothing to the tools that run inside it.
 *
 * ## Not one wall-clock reading anywhere (DOR-1729)
 *
 * Every budget below is dated from {@link EPOCH} and every handler is handed a
 * {@link fixedClock}, because a TTL is the one thing here that a busy runner
 * can decide instead of the code: this suite used to date a twenty-millisecond
 * deadline from `Date.now()`, and the handler's own startup — a `ensureSession`,
 * an awaited settings lookup — spent it before the turn began. The envelope was
 * then already expired when the deadline was read, which is a different path
 * from the mid-turn stop these cases are about: today it is refused before it
 * starts (DOR-1770) and binds nothing at all, and before that it quietly took
 * the five-second default, ran to completion, and released the very binding the
 * case is about. Two different wrong answers, one cause. The two assertions that
 * read `Date.now()` back had the same problem from the other end: the abort they
 * waited on is fired by a MONOTONIC timer and read back off the WALL clock, two
 * clocks that need only disagree by a millisecond at the boundary.
 *
 * So the deadline is spent in milliseconds the test owns, and the turns below
 * end when their stop actually lands rather than after a sleep long enough to
 * probably outlast it.
 */
import { describe, it, expect, vi } from 'vitest';
import { InboundTurnBudgets } from '../inbound-turn-budgets.js';
import { handleAgentMessage } from '../adapters/claude-code/agent-handler.js';
import { handleTasksMessage } from '../adapters/claude-code/task-handler.js';
import { AbortRegistry } from '../lib/abort-registry.js';
import type { AgentRuntimeLike } from '../adapters/claude-code/types.js';
import type { TraceStoreLike } from '../types.js';
import type { RelayEnvelope, RelayBudget } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';

const AGENT_ID = 'agent-1';
const SUBJECT = `relay.agent.demo.${AGENT_ID}`;

/** The one instant every budget in this suite is dated from. */
const EPOCH = Date.UTC(2026, 8, 3, 10, 0, 0);

/**
 * A clock the test moves by hand, so a deadline is spent in milliseconds it
 * owns rather than in whatever the runner had left.
 *
 * @param start - The instant it reads at first. Defaults to {@link EPOCH}.
 * @returns `now`, shaped to pass straight to a handler's `now` dependency, and
 *   `advance`, which is how time passes here.
 */
function fixedClock(start: number = EPOCH): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Settle once the given signal aborts — or immediately, if it already has. */
function onceAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function budget(overrides: Partial<RelayBudget> = {}): RelayBudget {
  return {
    hopCount: 1,
    maxHops: 5,
    ancestorChain: [SUBJECT],
    ttl: EPOCH + 60_000,
    callBudgetRemaining: 9,
    ...overrides,
  };
}

function envelope(): RelayEnvelope {
  return {
    id: '01ABC',
    subject: SUBJECT,
    from: 'relay.agent.demo.agent-2',
    budget: budget(),
    createdAt: new Date(EPOCH).toISOString(),
    payload: { text: 'keep me posted' },
  };
}

const traceStore: TraceStoreLike = { insertSpan: vi.fn(), updateSpan: vi.fn() };

/**
 * A runtime that reports what the budget registry said DURING its turn.
 *
 * @param inbound - The registry the adapter binds into.
 * @param seen - Collector for what the registry answered mid-turn.
 * @param throwMidTurn - Whether the turn should die partway, to prove release.
 * @param key - The session key the turn is bound under.
 */
function runtimeThatObserves(
  inbound: InboundTurnBudgets,
  seen: (RelayBudget | undefined)[],
  throwMidTurn = false,
  key: string = AGENT_ID
): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(() =>
      (async function* () {
        seen.push(inbound.get(key));
        if (throwMidTurn) throw new Error('the turn fell over');
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn(),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
}

describe('InboundTurnBudgets', () => {
  it('answers with the bound budget, and nothing once released', () => {
    const budgets = new InboundTurnBudgets();
    const b = budget();
    const release = budgets.bind('session-1', b);

    expect(budgets.get('session-1')).toBe(b);
    release();
    expect(budgets.get('session-1')).toBeUndefined();
  });

  it('tries several candidate keys in order, skipping the ones a caller does not have', () => {
    const budgets = new InboundTurnBudgets();
    const b = budget();
    budgets.bind('sdk-uuid', b);

    expect(budgets.get(undefined, 'sdk-uuid')).toBe(b);
    expect(budgets.get('nothing-here', 'sdk-uuid')).toBe(b);
    expect(budgets.get('nothing-here')).toBeUndefined();
  });

  it('a late release does not delete the NEWER turn it no longer owns', () => {
    const budgets = new InboundTurnBudgets();
    const first = budget({ callBudgetRemaining: 9 });
    const second = budget({ callBudgetRemaining: 4 });

    const releaseFirst = budgets.bind('session-1', first);
    budgets.bind('session-1', second);
    releaseFirst();

    expect(budgets.get('session-1')).toBe(second);
  });
});

describe('the dispatching adapter binds the turn (DOR-791)', () => {
  it('makes the inbound budget readable DURING the turn and gone after it', async () => {
    const budgets = new InboundTurnBudgets();
    const seen: (RelayBudget | undefined)[] = [];
    const clock = fixedClock();

    await handleAgentMessage(
      SUBJECT,
      envelope(),
      undefined,
      clock.now(),
      {
        agentManager: runtimeThatObserves(budgets, seen),
        traceStore,
        inboundBudgets: budgets,
        turnController: new AbortController(),
        now: clock.now,
      },
      null
    );

    expect(seen[0]?.callBudgetRemaining).toBe(9);
    expect(seen[0]?.hopCount).toBe(1);
    expect(budgets.get(AGENT_ID)).toBeUndefined();
  });

  it('releases the binding even when the turn dies partway through', async () => {
    const budgets = new InboundTurnBudgets();
    const seen: (RelayBudget | undefined)[] = [];
    const clock = fixedClock();

    await handleAgentMessage(
      SUBJECT,
      envelope(),
      undefined,
      clock.now(),
      {
        agentManager: runtimeThatObserves(budgets, seen, true),
        traceStore,
        inboundBudgets: budgets,
        turnController: new AbortController(),
        now: clock.now,
      },
      null
    );

    expect(budgets.size).toBe(0);
  });

  it('holds the (expired) budget when the turn dies on its own TTL', async () => {
    // The iteration stopping is not proof the query stopped. A `relay_send` that
    // landed in that window and inherited NOTHING would mint a fresh full budget
    // — hop zero, ten calls, another hour — which is the chain escaping on
    // exactly the deadline meant to end it. Inheriting a dead budget gets it
    // refused at the publish gate instead.
    const budgets = new InboundTurnBudgets();
    const clock = fixedClock();
    const TTL_MS = 5;
    const expiring = { ...envelope(), budget: budget({ ttl: clock.now() + TTL_MS }) };
    const turnController = new AbortController();

    const runtime: AgentRuntimeLike = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockImplementation(() =>
        (async function* () {
          // The turn is STILL ITERATING when its deadline lands: it waits for
          // the stop itself rather than for a sleep chosen to probably outlast
          // it. The clock moves to the deadline here, so what the assertion
          // reads back is the exact boundary rather than a wall-clock race.
          clock.advance(TTL_MS);
          await onceAborted(turnController.signal);
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      ),
      getSdkSessionId: vi.fn().mockReturnValue(undefined),
      approveTool: vi.fn(),
      interruptQuery: vi.fn().mockResolvedValue(true),
    };

    await handleAgentMessage(
      SUBJECT,
      expiring,
      undefined,
      clock.now(),
      {
        agentManager: runtime,
        traceStore,
        inboundBudgets: budgets,
        turnController,
        now: clock.now,
      },
      null
    );

    const held = budgets.get(AGENT_ID);
    // The envelope's own budget, not a copy and not a fresh one.
    expect(held).toBe(expiring.budget);
    // And dead by the clock this turn was measured on, which is what gets a late
    // send refused as `ttl_expired` at the publish gate.
    expect(held!.ttl).toBeLessThanOrEqual(clock.now());
  });

  it('spends the TTL on the clock it was handed, not on how long the turn took to start', async () => {
    // **The flake this closes (DOR-1729).** The deadline is
    // `budget.ttl - now()`, computed after `ensureSession` and after an AWAITED
    // settings lookup — so on a busy machine a millisecond-scale fixture TTL was
    // already gone by the time it was read, and the turn took a path this case
    // is not about: it is refused before it starts, binding nothing (DOR-1770),
    // where it used to quietly take `defaultTimeoutMs`, run to completion, and
    // release the binding this whole path exists to hold.
    //
    // Seeded defect: drop `now` from the deps below and this reds, because the
    // resolver's delay is longer than the TTL. With the clock injected the
    // delay is irrelevant — which is the property, at any load.
    const budgets = new InboundTurnBudgets();
    const clock = fixedClock();
    const expiring = { ...envelope(), budget: budget({ ttl: clock.now() + 5 }) };
    const turnController = new AbortController();

    const runtime: AgentRuntimeLike = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockImplementation(() =>
        (async function* () {
          await onceAborted(turnController.signal);
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      ),
      getSdkSessionId: vi.fn().mockReturnValue(undefined),
      approveTool: vi.fn(),
      interruptQuery: vi.fn().mockResolvedValue(true),
    };

    await handleAgentMessage(
      SUBJECT,
      expiring,
      undefined,
      clock.now(),
      {
        agentManager: runtime,
        traceStore,
        inboundBudgets: budgets,
        turnController,
        // The real startup cost, in the place the real one is paid.
        resolveExecutionSettings: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return {};
        },
        now: clock.now,
      },
      null
    );

    // Stopped by its own deadline — so the binding is held, and the turn did not
    // get a fresh sixty seconds out of a budget that had five milliseconds left.
    expect(turnController.signal.aborted).toBe(true);
    expect(budgets.get(AGENT_ID)).toBe(expiring.budget);
  });

  it('binds nothing when the host wired no registry — the pre-existing behaviour', async () => {
    const budgets = new InboundTurnBudgets();
    const seen: (RelayBudget | undefined)[] = [];
    const clock = fixedClock();

    await handleAgentMessage(
      SUBJECT,
      envelope(),
      undefined,
      clock.now(),
      {
        agentManager: runtimeThatObserves(budgets, seen),
        traceStore,
        turnController: new AbortController(),
        now: clock.now,
      },
      null
    );

    expect(seen[0]).toBeUndefined();
  });
});

describe('a scheduled task turn is bound too (DOR-791)', () => {
  const RUN_ID = 'run-1';

  /** A valid task dispatch payload for the run below. */
  function taskEnvelope(): RelayEnvelope {
    return {
      id: '01TASK',
      subject: 'relay.system.tasks.nightly',
      from: 'relay.system.scheduler',
      budget: budget({ callBudgetRemaining: 7 }),
      createdAt: new Date(EPOCH).toISOString(),
      payload: {
        type: 'task_dispatch',
        taskId: 'task-1',
        runId: RUN_ID,
        prompt: 'run the nightly report',
        cwd: null,
        permissionMode: 'default',
        taskName: 'Nightly',
        cron: null,
        trigger: 'schedule',
      },
    };
  }

  it('makes the dispatch budget readable during the run and releases it after', async () => {
    // A scheduled run is an agent turn like any other and can message peers from
    // inside it. Without this it started every chain over.
    const budgets = new InboundTurnBudgets();
    const seen: (RelayBudget | undefined)[] = [];
    const clock = fixedClock();

    await handleTasksMessage(
      'relay.system.tasks.nightly',
      taskEnvelope(),
      undefined,
      clock.now(),
      { defaultCwd: '/tmp' },
      {
        agentManager: runtimeThatObserves(budgets, seen, false, RUN_ID),
        traceStore,
        runningTasks: new AbortRegistry(),
        inboundBudgets: budgets,
        now: clock.now,
      }
    );

    expect(seen[0]?.callBudgetRemaining).toBe(7);
    expect(budgets.get(RUN_ID)).toBeUndefined();
  });

  it('holds the binding when the run is stopped, exactly as the agent turn does', async () => {
    // `consumeRunStream` ABANDONS the stream on a stop: both the interrupt and
    // the iterator's `return()` are fired unawaited, and `interruptTurn` is
    // itself bounded and best-effort — so the run being over here is a request,
    // not a proof. A `relay_send` from the orphan that inherited nothing would
    // mint a fresh full budget, which is the chain escaping on exactly the stop
    // meant to end it.
    const budgets = new InboundTurnBudgets();
    const seen: (RelayBudget | undefined)[] = [];
    const clock = fixedClock();
    const TTL_MS = 5;
    const expiring: RelayEnvelope = {
      ...taskEnvelope(),
      budget: budget({ callBudgetRemaining: 7, ttl: clock.now() + TTL_MS }),
    };

    const runtime: AgentRuntimeLike = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockImplementation(() =>
        (async function* () {
          seen.push(budgets.get(RUN_ID));
          // Never settles: the run's own deadline is the only thing that can end
          // it, and `consumeRunStream` abandons the stream when that lands. A
          // sleep here would be a bet that the runner fires a timer before it
          // finishes a sleep, which is the bet that flaked.
          clock.advance(TTL_MS);
          await new Promise(() => {});
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      ),
      getSdkSessionId: vi.fn().mockReturnValue(undefined),
      approveTool: vi.fn(),
      interruptQuery: vi.fn().mockResolvedValue(true),
    };

    await handleTasksMessage(
      'relay.system.tasks.nightly',
      expiring,
      undefined,
      clock.now(),
      { defaultCwd: '/tmp' },
      {
        agentManager: runtime,
        traceStore,
        runningTasks: new AbortRegistry(),
        inboundBudgets: budgets,
        now: clock.now,
      }
    );

    // Still bound, and bound to a budget the publish gate will refuse — so a
    // late send inherits a dead chain instead of starting a fresh one.
    const held = budgets.get(RUN_ID);
    expect(held).toBe(expiring.budget);
    expect(held!.callBudgetRemaining).toBe(7);
    expect(held!.ttl).toBeLessThanOrEqual(clock.now());
  });
});
