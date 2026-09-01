import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope, TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleTasksMessage } from '../task-handler.js';
import type { TasksHandlerDeps, TasksHandlerConfig } from '../task-handler.js';
import type { AgentRuntimeLike, TasksStoreLike } from '../types.js';
import type { TraceStoreLike } from '../../../types.js';
import { AbortRegistry } from '../../../lib/abort-registry.js';

/**
 * A relay-dispatched run that hit an error must say so on its own row, exactly
 * as the direct-dispatch twin in `apps/server` does (DOR-1658). The two share
 * the settlement rule (`@dorkos/shared/run-outcome`) so they cannot disagree;
 * what this file pins is that this path actually asks it.
 */

function agentManagerYielding(events: StreamEvent[]): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* (): AsyncGenerator<StreamEvent> {
        for (const event of events) yield event;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  } as unknown as AgentRuntimeLike;
}

function envelopeFor(payload: TaskDispatchPayload): RelayEnvelope {
  return {
    id: 'msg-1',
    subject: `relay.system.tasks.${payload.taskId}`,
    from: 'system:tasks',
    budget: { hopCount: 0, ttl: Date.now() + 60_000 },
    payload,
  } as unknown as RelayEnvelope;
}

const payload: TaskDispatchPayload = {
  type: 'task_dispatch',
  taskId: 'task-1',
  runId: 'run-1',
  prompt: 'do the thing',
  cwd: '/tmp/project',
  permissionMode: 'acceptEdits',
  taskName: 'Nightly',
  cron: '0 2 * * *',
  trigger: 'scheduled',
} as TaskDispatchPayload;

describe('a relay-dispatched run that hit an error (DOR-1658)', () => {
  let traceStore: TraceStoreLike;
  let taskStore: TasksStoreLike;
  const config: TasksHandlerConfig = { defaultCwd: '/tmp' };

  beforeEach(() => {
    traceStore = { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike;
    taskStore = { updateRun: vi.fn() } as unknown as TasksStoreLike;
  });

  /** Run one turn to its terminal write and hand back what it wrote. */
  async function runTurn(events: StreamEvent[]): Promise<Record<string, unknown>> {
    const deps: TasksHandlerDeps = {
      agentManager: agentManagerYielding(events),
      traceStore,
      taskStore,
      runningTasks: new AbortRegistry(),
    };
    await handleTasksMessage('sub', envelopeFor(payload), undefined, Date.now(), config, deps);
    const calls = vi.mocked(taskStore.updateRun).mock.calls;
    return calls[calls.length - 1]![1] as Record<string, unknown>;
  }

  it('writes a failed row carrying the message, not a completed one', async () => {
    const written = await runTurn([
      { type: 'text_delta', data: { text: 'starting' } },
      { type: 'error', data: { message: 'API Error: 500 upstream' } },
    ]);

    expect(written).toMatchObject({
      status: 'failed',
      error: 'API Error: 500 upstream',
      outputSummary: 'starting',
    });
  });

  it('leads an expired sign-in with what to do about it', async () => {
    const written = await runTurn([
      {
        type: 'error',
        data: { message: 'OAuth access token has been revoked', category: 'auth_error' },
      },
      { type: 'done', data: { sessionId: 's' } },
    ]);

    expect(written).toMatchObject({
      status: 'failed',
      error: 'Sign in again: OAuth access token has been revoked',
    });
  });

  it('leaves a clean run completed, with no error line', async () => {
    const written = await runTurn([
      { type: 'text_delta', data: { text: 'all done' } },
      { type: 'done', data: { sessionId: 's' } },
    ]);

    expect(written).toMatchObject({ status: 'completed', outputSummary: 'all done' });
    expect(written.error).toBeUndefined();
  });

  it('still completes a run whose mid-turn error the runtime recovered from', async () => {
    const written = await runTurn([
      { type: 'error', data: { message: 'a tool blew up' } },
      { type: 'text_delta', data: { text: 'carried on' } },
      { type: 'session_status', data: { sessionId: 's', terminalReason: 'completed' } },
      { type: 'done', data: { sessionId: 's' } },
    ]);

    expect(written).toMatchObject({ status: 'completed' });
    expect(written.error).toBeUndefined();
  });

  it('reports the DELIVERY as a success — the run failed, the envelope did not', async () => {
    // A failed run must not be dead-lettered and redelivered: the work ran.
    const deps: TasksHandlerDeps = {
      agentManager: agentManagerYielding([
        { type: 'error', data: { message: 'the model errored' } },
      ]),
      traceStore,
      taskStore,
      runningTasks: new AbortRegistry(),
    };

    const result = await handleTasksMessage(
      'sub',
      envelopeFor(payload),
      undefined,
      Date.now(),
      config,
      deps
    );

    expect(result.success).toBe(true);
    expect(result.deadLettered).toBeUndefined();
    expect(traceStore.updateSpan).toHaveBeenCalledWith(
      'msg-1',
      expect.objectContaining({ status: 'processed' })
    );
  });
});
