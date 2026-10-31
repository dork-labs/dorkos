/**
 * A relay-dispatched run the computer slept through is not stopped as over its
 * time limit (DOR-3286). Its deadline counts only awake time: real timers at a
 * small scale, under a clock that reports how long the computer slept.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope, TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { createAwakeClock, type AwakeClock } from '@dorkos/shared/awake-clock';
import { handleTasksMessage, type TasksHandlerDeps } from '../task-handler.js';
import type { AgentRuntimeLike, TasksStoreLike } from '../types.js';
import type { TraceStoreLike } from '../../../types.js';
import { AbortRegistry } from '../../../lib/abort-registry.js';

/** Real timers, and a sleep total the test sets. */
function reportedSleep(): { clock: AwakeClock; slept: (ms: number) => void } {
  const real = createAwakeClock();
  real.dispose();
  let slept = 0;
  return {
    clock: { ...real, sleptMs: () => slept, lastWakeAt: () => null },
    slept: (ms) => (slept += ms),
  };
}

/** A turn that emits one event, works for `ms`, then finishes. */
function agentWorkingFor(ms: number, onStart: () => void = () => {}): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'working' } };
        onStart();
        await new Promise((resolve) => setTimeout(resolve, ms));
        yield { type: 'done', data: { sessionId: 's' } };
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  } as unknown as AgentRuntimeLike;
}

const payload = {
  type: 'task_dispatch',
  taskId: 'task-1',
  runId: 'run-1',
  prompt: 'do the thing',
  cwd: '/tmp/project',
  permissionMode: 'acceptEdits',
  taskName: 'Nightly',
  cron: '0 3 * * *',
  trigger: 'scheduled',
  timeLimit: '30m',
} as TaskDispatchPayload;

async function runUnder(
  agentManager: AgentRuntimeLike,
  clock: AwakeClock,
  limitMs: number
): Promise<Record<string, unknown>> {
  const taskStore = { updateRun: vi.fn() } as unknown as TasksStoreLike;
  const deps: TasksHandlerDeps = {
    agentManager,
    traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike,
    taskStore,
    runningTasks: new AbortRegistry(),
    awakeClock: clock,
  };
  const envelope = {
    id: 'msg-1',
    subject: `relay.system.tasks.${payload.taskId}`,
    from: 'relay.system.tasks.scheduler',
    budget: { hopCount: 0, ttl: Date.now() + limitMs },
    payload,
  } as unknown as RelayEnvelope;
  await handleTasksMessage('sub', envelope, undefined, Date.now(), { defaultCwd: '/tmp' }, deps);
  const calls = vi.mocked(taskStore.updateRun).mock.calls;
  return calls[calls.length - 1]![1] as Record<string, unknown>;
}

describe('a relay-dispatched run the computer slept through', () => {
  it('finishes, rather than being stopped on wake as over its time limit', async () => {
    const { clock, slept } = reportedSleep();
    // 1s of work under a 500ms limit, 900ms of which the computer slept: 100ms awake.
    const written = await runUnder(
      agentWorkingFor(1_000, () => slept(900)),
      clock,
      500
    );
    expect(written).toMatchObject({ status: 'completed' });
    expect(written.error).toBeUndefined();
  });

  it('still stops a run that was awake for its whole limit', async () => {
    const { clock } = reportedSleep();
    const written = await runUnder(agentWorkingFor(2_000), clock, 300);
    expect(written).toMatchObject({
      status: 'cancelled',
      error: 'Run stopped after passing its 30m time limit',
    });
  });
});
