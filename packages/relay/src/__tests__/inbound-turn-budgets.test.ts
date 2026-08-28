/**
 * DOR-791: an agent turn the bus started knows which envelope it is answering,
 * so the messages it sends continue that budget instead of minting a fresh one.
 *
 * The registry half is unit-tested here; the half that matters — that the
 * dispatching adapter actually binds it FOR THE DURATION OF THE TURN, and
 * releases it however the turn ends — is driven through the real
 * ClaudeCodeAdapter, because a binding that exists only after the turn is over
 * is worth nothing to the tools that run inside it.
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

function budget(overrides: Partial<RelayBudget> = {}): RelayBudget {
  return {
    hopCount: 1,
    maxHops: 5,
    ancestorChain: [SUBJECT],
    ttl: Date.now() + 60_000,
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
    createdAt: new Date().toISOString(),
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

    await handleAgentMessage(
      SUBJECT,
      envelope(),
      undefined,
      Date.now(),
      { defaultTimeoutMs: 5_000 },
      {
        agentManager: runtimeThatObserves(budgets, seen),
        traceStore,
        inboundBudgets: budgets,
        turnController: new AbortController(),
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

    await handleAgentMessage(
      SUBJECT,
      envelope(),
      undefined,
      Date.now(),
      { defaultTimeoutMs: 5_000 },
      {
        agentManager: runtimeThatObserves(budgets, seen, true),
        traceStore,
        inboundBudgets: budgets,
        turnController: new AbortController(),
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
    const expiring = { ...envelope(), budget: budget({ ttl: Date.now() + 20 }) };

    const runtime: AgentRuntimeLike = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockImplementation(() =>
        (async function* () {
          // Outlives the TTL, so the handler aborts mid-iteration.
          await new Promise((r) => setTimeout(r, 200));
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
      Date.now(),
      { defaultTimeoutMs: 5_000 },
      {
        agentManager: runtime,
        traceStore,
        inboundBudgets: budgets,
        turnController: new AbortController(),
      },
      null
    );

    const held = budgets.get(AGENT_ID);
    expect(held).toBeDefined();
    expect(held!.ttl).toBeLessThanOrEqual(Date.now());
  });

  it('binds nothing when the host wired no registry — the pre-existing behaviour', async () => {
    const budgets = new InboundTurnBudgets();
    const seen: (RelayBudget | undefined)[] = [];

    await handleAgentMessage(
      SUBJECT,
      envelope(),
      undefined,
      Date.now(),
      { defaultTimeoutMs: 5_000 },
      {
        agentManager: runtimeThatObserves(budgets, seen),
        traceStore,
        turnController: new AbortController(),
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
      createdAt: new Date().toISOString(),
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

    await handleTasksMessage(
      'relay.system.tasks.nightly',
      taskEnvelope(),
      undefined,
      Date.now(),
      { defaultCwd: '/tmp' },
      {
        agentManager: runtimeThatObserves(budgets, seen, false, RUN_ID),
        traceStore,
        runningTasks: new AbortRegistry(),
        inboundBudgets: budgets,
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
    const expiring: RelayEnvelope = {
      ...taskEnvelope(),
      budget: budget({ callBudgetRemaining: 7, ttl: Date.now() + 20 }),
    };

    const runtime: AgentRuntimeLike = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockImplementation(() =>
        (async function* () {
          seen.push(budgets.get(RUN_ID));
          // Outlives the run's TTL, so the handler stops mid-stream.
          await new Promise((r) => setTimeout(r, 200));
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
      Date.now(),
      { defaultCwd: '/tmp' },
      {
        agentManager: runtime,
        traceStore,
        runningTasks: new AbortRegistry(),
        inboundBudgets: budgets,
      }
    );

    // Still bound, and bound to a budget the publish gate will refuse — so a
    // late send inherits a dead chain instead of starting a fresh one.
    const held = budgets.get(RUN_ID);
    expect(held).toBeDefined();
    expect(held!.callBudgetRemaining).toBe(7);
    expect(held!.ttl).toBeLessThanOrEqual(Date.now());
  });
});
