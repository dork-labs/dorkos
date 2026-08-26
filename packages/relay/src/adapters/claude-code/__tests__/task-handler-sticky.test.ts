import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleTasksMessage } from '../task-handler.js';
import type { TasksHandlerDeps, TasksHandlerConfig } from '../task-handler.js';
import type { AgentRuntimeLike, TasksStoreLike } from '../types.js';
import type { TraceStoreLike } from '../../../types.js';
import { AbortRegistry } from '../../../lib/abort-registry.js';

/**
 * The relay half of sticky sessions (DOR-1571): the receiver must run a sticky
 * task's turn on the session the scheduler resolved and carried on the wire, and
 * write that same id onto the run row — never the run id it defaulted to before.
 */

function mockAgentManager(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    // A turn that ends immediately, so the handler runs to a terminal write.
    sendMessage: vi.fn().mockReturnValue(
      (async function* (): AsyncGenerator<StreamEvent> {
        // no events → immediate completion
      })()
    ),
    // Models the SDK remap: after the turn, the session's real id differs from
    // the key it was handed. The handler must persist THIS, not the key.
    getSdkSessionId: vi.fn().mockReturnValue('sdk-real-after-turn'),
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

function basePayload(overrides: Partial<TaskDispatchPayload>): TaskDispatchPayload {
  return {
    type: 'task_dispatch',
    taskId: 'task-1',
    runId: 'run-1',
    prompt: 'do the thing',
    cwd: '/tmp/project',
    permissionMode: 'acceptEdits',
    taskName: 'Nightly',
    cron: '0 2 * * *',
    trigger: 'scheduled',
    ...overrides,
  };
}

describe('handleTasksMessage sticky session (DOR-1571)', () => {
  let agentManager: AgentRuntimeLike;
  let traceStore: TraceStoreLike;
  let taskStore: TasksStoreLike;
  let deps: TasksHandlerDeps;
  const config: TasksHandlerConfig = { defaultCwd: '/tmp' };

  beforeEach(() => {
    agentManager = mockAgentManager();
    traceStore = { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike;
    taskStore = { updateRun: vi.fn() } as unknown as TasksStoreLike;
    deps = { agentManager, traceStore, taskStore, runningTasks: new AbortRegistry() };
  });

  it('runs on the carried session and resumes it, writing that id to the run row', async () => {
    const payload = basePayload({
      runId: 'run-9',
      // The resume target is a REAL prior SDK id (whose transcript exists), not a
      // synthetic one — that is the whole fix.
      sessionId: 'sdk-prev-uuid',
      resumeSession: true,
    });

    await handleTasksMessage('sub', envelopeFor(payload), undefined, Date.now(), config, deps);

    // The turn ran on the carried resume target, resuming it.
    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'sdk-prev-uuid',
      expect.objectContaining({ hasStarted: true, unattended: true })
    );
    expect(agentManager.sendMessage).toHaveBeenCalledWith(
      'sdk-prev-uuid',
      'do the thing',
      expect.anything()
    );
    // The run row records the RUNTIME's own id after the turn (via getSdkSessionId),
    // so the next fire resumes it and the run opens the real transcript — not the
    // key the handler was passed.
    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-9',
      expect.objectContaining({ status: 'completed', sessionId: 'sdk-real-after-turn' })
    );
  });

  it('falls back to the run id and starts fresh when no session is carried (unchanged)', async () => {
    const payload = basePayload({ runId: 'run-7' });

    await handleTasksMessage('sub', envelopeFor(payload), undefined, Date.now(), config, deps);

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'run-7',
      expect.objectContaining({ hasStarted: false })
    );
    expect(agentManager.sendMessage).toHaveBeenCalledWith(
      'run-7',
      'do the thing',
      expect.anything()
    );
    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-7',
      expect.objectContaining({ status: 'completed', sessionId: 'run-7' })
    );
  });
});
