import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../index.js';
import type {
  AgentRuntimeLike,
  ClaudeCodeAdapterDeps,
  TasksStoreLike,
  TraceStoreLike,
} from '../index.js';
import type { MessageHandler, RelayPublisher } from '../../../types.js';
import {
  RunningTasks,
  handleTaskCancel,
  TASK_CANCEL_SUBJECT_PATTERN,
} from '../task-cancel-handler.js';
import { TASK_CANCEL_SUBJECT_PREFIX, TASK_SCHEDULER_PRINCIPAL } from '@dorkos/shared/relay-schemas';

function createMockAgentManager(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
}

/**
 * A turn that emits one event and then parks forever — the shape of a run
 * blocked on a tool-approval prompt nobody will answer. `parked` resolves once
 * the consumer has asked for the event that will never come.
 */
function parkedTurn(): { stream: AsyncGenerator<StreamEvent>; parked: Promise<void> } {
  let signalParked!: () => void;
  const parked = new Promise<void>((resolve) => {
    signalParked = resolve;
  });
  const stream = (async function* () {
    yield { type: 'text_delta', data: { text: 'starting' } } as StreamEvent;
    signalParked();
    await new Promise(() => {});
  })();
  return { stream, parked };
}

/**
 * A turn that parks until the test releases it, then ends normally — a run
 * that is genuinely in flight but can be finished without a stop.
 */
function releasableTurn(): {
  stream: AsyncGenerator<StreamEvent>;
  parked: Promise<void>;
  release: () => void;
} {
  let signalParked!: () => void;
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    signalParked = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = (async function* () {
    yield { type: 'text_delta', data: { text: 'starting' } } as StreamEvent;
    signalParked();
    await held;
    yield { type: 'done', data: {} } as StreamEvent;
  })();
  return { stream, parked, release };
}

/**
 * A turn that ends normally, but whose LAST event lands in the same instant
 * something stops the run.
 *
 * This is the one window where "did a stop end this run?" and "is the signal
 * aborted?" give different answers, and it is not reachable with a plain
 * generator — the abort has to be queued between the final `next()` resolving
 * and the consumer's continuation running. A hand-rolled iterator is the only
 * way to put it exactly there, so the race is deterministic instead of a
 * coin-flip that reproduces once a fortnight. Twin of the direct-dispatch case
 * in `apps/server/src/services/tasks/__tests__/task-scheduler-service.test.ts`.
 *
 * @param stopAtEnd - Called as the stream ends; queued so it lands after the
 *   final `next()` has already resolved `done`.
 */
function turnThatEndsAsItIsStopped(stopAtEnd: () => void): AsyncGenerator<StreamEvent> {
  let calls = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<StreamEvent>> {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          done: false,
          value: { type: 'text_delta', data: { text: 'ok' } } as StreamEvent,
        });
      }
      queueMicrotask(stopAtEnd);
      return Promise.resolve({ done: true, value: undefined });
    },
  } as AsyncGenerator<StreamEvent>;
}

function createTasksEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: 'msg-dispatch',
    subject: 'relay.system.tasks.sched-1',
    from: TASK_SCHEDULER_PRINCIPAL,
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 5,
    },
    createdAt: new Date().toISOString(),
    payload: {
      type: 'task_dispatch',
      taskId: 'sched-1',
      runId: 'run-1',
      prompt: 'Check the budget',
      cwd: '/home/user/project',
      permissionMode: 'default',
      taskName: 'Budget Monitor',
      cron: '0 * * * *',
      trigger: 'scheduled',
    },
    ...overrides,
  };
}

function cancelEnvelope(runId: string, payload?: unknown): RelayEnvelope {
  return {
    id: `msg-cancel-${runId}`,
    subject: `${TASK_CANCEL_SUBJECT_PREFIX}${runId}`,
    from: TASK_SCHEDULER_PRINCIPAL,
    budget: {
      hopCount: 0,
      maxHops: 1,
      ancestorChain: [],
      ttl: Date.now() + 30_000,
      callBudgetRemaining: 1,
    },
    createdAt: new Date().toISOString(),
    payload: payload ?? { type: 'task_cancel', runId },
  };
}

const silentLog = { warn: vi.fn(), debug: vi.fn() };

describe('handleTaskCancel', () => {
  it('stops a run this adapter is executing', () => {
    const running = new RunningTasks();
    const controller = new AbortController();
    running.register('run-1', controller);

    const verdict = handleTaskCancel(cancelEnvelope('run-1'), running, silentLog);

    expect(verdict).toBeUndefined();
    expect(controller.signal.aborted).toBe(true);
  });

  it('refuses — without throwing — for a run nobody here is executing', () => {
    const running = new RunningTasks();

    const verdict = handleTaskCancel(cancelEnvelope('ghost-run'), running, silentLog);

    // A refusal, not a silent success: it is what makes the publisher's
    // deliveredTo an honest answer to "did anything take this?".
    expect(verdict).toEqual({ handled: false, reason: expect.stringContaining('ghost-run') });
  });

  it('refuses a stop from anyone but the scheduler, without touching the run', () => {
    const running = new RunningTasks();
    const controller = new AbortController();
    running.register('run-1', controller);

    const verdict = handleTaskCancel(
      { ...cancelEnvelope('run-1'), from: 'relay.agent.some-other-agent' },
      running,
      silentLog
    );

    expect(verdict).toEqual({ handled: false, reason: expect.stringContaining('scheduler') });
    expect(controller.signal.aborted).toBe(false);
  });

  it('refuses a payload that is not a stop request', () => {
    const running = new RunningTasks();

    const verdict = handleTaskCancel(
      cancelEnvelope('run-1', { type: 'something_else' }),
      running,
      silentLog
    );

    expect(verdict).toEqual({ handled: false, reason: expect.any(String) });
  });

  it('is idempotent — a second stop changes nothing', () => {
    const running = new RunningTasks();
    const controller = new AbortController();
    running.register('run-1', controller);

    handleTaskCancel(cancelEnvelope('run-1'), running, silentLog);
    const reason = controller.signal.reason;
    const second = handleTaskCancel(cancelEnvelope('run-1'), running, silentLog);

    expect(second).toBeUndefined();
    expect(controller.signal.reason).toBe(reason);
  });

  it('does not let a late release unregister a newer run with the same id', () => {
    const running = new RunningTasks();
    const first = new AbortController();
    const second = new AbortController();
    running.register('run-1', first);
    running.register('run-1', second);

    running.release('run-1', first);

    expect(running.stop('run-1')).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});

describe('ClaudeCodeAdapter — stopping a relay-dispatched run', () => {
  let agentManager: AgentRuntimeLike;
  let traceStore: TraceStoreLike;
  let taskStore: TasksStoreLike;
  let relay: RelayPublisher;
  let adapter: ClaudeCodeAdapter;

  /** The handler the adapter registered for stop requests. */
  function cancelHandler(): MessageHandler {
    const call = vi
      .mocked(relay.subscribe)
      .mock.calls.find(([pattern]) => pattern === TASK_CANCEL_SUBJECT_PATTERN);
    if (!call) throw new Error('adapter never subscribed to stop requests');
    return call[1];
  }

  beforeEach(() => {
    agentManager = createMockAgentManager();
    traceStore = { insertSpan: vi.fn(), updateSpan: vi.fn() };
    taskStore = { updateRun: vi.fn() };
    relay = {
      publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 1 }),
      onSignal: vi.fn().mockReturnValue(() => {}),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };
    // This suite is about the CANCEL bus, not the approval one, so the
    // approval gate is a permissive stand-in — `approval-handler.test.ts` owns
    // proving it refuses.
    const deps: ClaudeCodeAdapterDeps = {
      agentManager,
      traceStore,
      taskStore,
      approvalAuthorizer: () => true,
    };
    adapter = new ClaudeCodeAdapter('claude-code', { defaultCwd: '/default/cwd' }, deps);
  });

  it('ends the turn at the agent and records the run as cancelled', async () => {
    await adapter.start(relay);
    const turn = parkedTurn();
    vi.mocked(agentManager.sendMessage).mockReturnValue(turn.stream);
    const envelope = createTasksEnvelope();

    const delivery = adapter.deliver(envelope.subject, envelope);
    await turn.parked;

    const verdict = await cancelHandler()(cancelEnvelope('run-1'));
    const result = await delivery;

    expect(verdict).toBeUndefined();
    // The runtime is told to stop, not merely marked stopped in the store.
    expect(agentManager.interruptQuery).toHaveBeenCalledWith('run-1');
    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'cancelled', error: 'Run cancelled' })
    );
    // A run somebody stopped on purpose is a delivery that worked.
    expect(result.success).toBe(true);
  });

  it('reaches a run even when every concurrency slot is taken', async () => {
    // The whole reason a stop travels by subscription: deliver() holds a slot
    // for the run's entire life, so a stop routed through it would queue
    // behind the very run it is trying to end.
    const single = new ClaudeCodeAdapter(
      'claude-code',
      { defaultCwd: '/default/cwd', maxConcurrent: 1 },
      { agentManager, traceStore, taskStore, approvalAuthorizer: () => true }
    );
    await single.start(relay);
    const turn = parkedTurn();
    vi.mocked(agentManager.sendMessage).mockReturnValue(turn.stream);
    const envelope = createTasksEnvelope();

    const delivery = single.deliver(envelope.subject, envelope);
    await turn.parked;

    await cancelHandler()(cancelEnvelope('run-1'));
    await delivery;

    expect(agentManager.interruptQuery).toHaveBeenCalledWith('run-1');
  });

  it('still reads a deadline as a deadline, not as somebody pressing Stop', async () => {
    await adapter.start(relay);
    const turn = parkedTurn();
    vi.mocked(agentManager.sendMessage).mockReturnValue(turn.stream);
    const envelope = createTasksEnvelope({
      budget: {
        hopCount: 0,
        maxHops: 5,
        ancestorChain: [],
        ttl: Date.now() + 150,
        callBudgetRemaining: 5,
      },
    });

    const delivery = adapter.deliver(envelope.subject, envelope);
    await turn.parked;
    const result = await delivery;

    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'cancelled',
        error: 'Run timed out (TTL budget expired)',
      })
    );
    expect(result.success).toBe(false);
  });

  it('records a run that FINISHED as completed, even when a stop lands in the same instant', async () => {
    // The stop lost, by a microtask. Reading `signal.aborted` after the fact
    // cannot tell that from a stop that won, so a run that finished its work
    // was filed as cancelled — with output, and with nothing interrupted.
    await adapter.start(relay);
    const handler = cancelHandler();
    vi.mocked(agentManager.sendMessage).mockReturnValue(
      turnThatEndsAsItIsStopped(() => void handler(cancelEnvelope('run-1')))
    );

    const result = await adapter.deliver('relay.system.tasks.sched-1', createTasksEnvelope());

    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'completed' })
    );
    expect(taskStore.updateRun).not.toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'cancelled' })
    );
    expect(result.success).toBe(true);
  });

  it('refuses a stop for a run that already completed, and leaves its record alone', async () => {
    await adapter.start(relay);
    const envelope = createTasksEnvelope();

    const result = await adapter.deliver(envelope.subject, envelope);
    expect(result.success).toBe(true);
    vi.mocked(taskStore.updateRun).mockClear();

    const verdict = await cancelHandler()(cancelEnvelope('run-1'));

    expect(verdict).toEqual({ handled: false, reason: expect.stringContaining('run-1') });
    expect(taskStore.updateRun).not.toHaveBeenCalled();
    expect(agentManager.interruptQuery).not.toHaveBeenCalled();
  });

  it('refuses a stop after the adapter restarts — it no longer knows the run', async () => {
    await adapter.start(relay);
    const turn = releasableTurn();
    vi.mocked(agentManager.sendMessage).mockReturnValue(turn.stream);
    const delivery = adapter.deliver('relay.system.tasks.sched-1', createTasksEnvelope());
    await turn.parked;
    const handler = cancelHandler();

    await adapter.stop();

    // The registry does not survive the restart; the run is finalized by its
    // own handler either way. Saying "stopped" here would be a guess.
    expect(await handler(cancelEnvelope('run-1'))).toEqual({
      handled: false,
      reason: expect.stringContaining('run-1'),
    });

    turn.release();
    await delivery;
    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'completed' })
    );
  });
});
