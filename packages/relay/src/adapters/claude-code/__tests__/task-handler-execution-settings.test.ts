/**
 * The relay half of per-task model and effort (DOR-1615, DOR-1347): a scheduled
 * run that travels the bus must start its turn on the model and effort the
 * SCHEDULER resolved and carried on the wire.
 *
 * The receiver runs in another process and can rebuild none of that ladder — it
 * has no task row, no agent manifest and no server config — so anything it does
 * not read off the envelope, it does not know.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope, TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleTasksMessage } from '../task-handler.js';
import type { TasksHandlerDeps, TasksHandlerConfig } from '../task-handler.js';
import type { AgentRuntimeLike, TasksStoreLike } from '../types.js';
import type { TraceStoreLike } from '../../../types.js';
import { AbortRegistry } from '../../../lib/abort-registry.js';

function mockAgentManager(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* (): AsyncGenerator<StreamEvent> {
        // no events → immediate completion
      })()
    ),
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

function basePayload(overrides: Partial<TaskDispatchPayload> = {}): TaskDispatchPayload {
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

describe('handleTasksMessage execution settings (DOR-1615/DOR-1347)', () => {
  let agentManager: AgentRuntimeLike;
  let deps: TasksHandlerDeps;
  const config: TasksHandlerConfig = { defaultCwd: '/tmp' };

  beforeEach(() => {
    agentManager = mockAgentManager();
    deps = {
      agentManager,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike,
      taskStore: { updateRun: vi.fn() } as unknown as TasksStoreLike,
      runningTasks: new AbortRegistry(),
    };
  });

  it('spreads the carried model and effort into BOTH agent calls', async () => {
    // Both, and not by accident. The claude-code runtime reads `session.model`
    // when it LAUNCHES a query, and that field is written once — at session
    // creation — so a model handed over only at `sendMessage` reaches nothing.
    // A runtime that does not hold sessions in memory sees the send and not the
    // create. `agent-handler.ts` spreads its own settings into both for exactly
    // this reason.
    await handleTasksMessage(
      'sub',
      envelopeFor(basePayload({ model: 'haiku', effort: 'low' })),
      undefined,
      Date.now(),
      config,
      deps
    );

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ model: 'haiku', effort: 'low' })
    );
    expect(agentManager.sendMessage).toHaveBeenCalledWith(
      'run-1',
      'do the thing',
      expect.objectContaining({ model: 'haiku', effort: 'low' })
    );
  });

  it('carries a model on its own, with no effort invented alongside it', async () => {
    await handleTasksMessage(
      'sub',
      envelopeFor(basePayload({ model: 'gpt-5.5' })),
      undefined,
      Date.now(),
      config,
      deps
    );

    const [, ensureOpts] = vi.mocked(agentManager.ensureSession).mock.calls[0]!;
    expect(ensureOpts).toMatchObject({ model: 'gpt-5.5' });
    expect(ensureOpts).not.toHaveProperty('effort');
  });

  it('mentions NEITHER key when the envelope carries neither', async () => {
    // The compatibility case: absent means "the runtime decides", which is what
    // every task envelope meant before these fields — so an envelope written by
    // an older build (a dead-letter replay) still runs, and runs identically. A
    // `model: undefined` handed to the runtime is not the same as silence.
    await handleTasksMessage(
      'sub',
      envelopeFor(basePayload()),
      undefined,
      Date.now(),
      config,
      deps
    );

    const [, ensureOpts] = vi.mocked(agentManager.ensureSession).mock.calls[0]!;
    const [, , sendOpts] = vi.mocked(agentManager.sendMessage).mock.calls[0]!;
    expect(ensureOpts).not.toHaveProperty('model');
    expect(ensureOpts).not.toHaveProperty('effort');
    expect(sendOpts).not.toHaveProperty('model');
    expect(sendOpts).not.toHaveProperty('effort');
  });
});
