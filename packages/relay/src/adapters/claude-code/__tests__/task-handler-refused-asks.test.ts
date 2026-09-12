/**
 * A relay-dispatched run reports the asks nobody was there to answer (DOR-1580).
 *
 * The run's own summary line already said which tools it could not use. The
 * activity feed did not: `emitRefusedAskActivity` was wired only on the direct
 * dispatch path, and with a relay adapter connected — the ordinary install — a
 * scheduled run goes this way instead, so the entry existed for nobody. This
 * package cannot see the feed, so what it owes the host is a report per refused
 * tool; what the host does with it is `run-activity.ts`'s business.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope, TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleTasksMessage } from '../task-handler.js';
import type { TasksHandlerDeps, TasksHandlerConfig } from '../task-handler.js';
import type { AgentRuntimeLike, RefusedAskReporter, TasksStoreLike } from '../types.js';
import type { TraceStoreLike } from '../../../types.js';
import { AbortRegistry } from '../../../lib/abort-registry.js';

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

/** DorkOS's own refusal record, exactly as the interactive handlers push it. */
function nobodyThere(toolName: string): StreamEvent {
  return {
    type: 'permission_denied',
    data: {
      toolCallId: `call-${toolName}`,
      toolName,
      reasonType: 'no_approval_surface',
      reason: 'nobody was available to approve this tool',
      message: 'Nobody is available to approve this on a scheduled run.',
    },
  } as StreamEvent;
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

function envelopeFor(): RelayEnvelope {
  return {
    id: 'msg-1',
    subject: `relay.system.tasks.${payload.taskId}`,
    from: 'system:tasks',
    budget: { hopCount: 0, ttl: Date.now() + 60_000 },
    payload,
  } as unknown as RelayEnvelope;
}

describe('the refused asks a relay-dispatched run reports', () => {
  let traceStore: TraceStoreLike;
  let taskStore: TasksStoreLike;
  let onRefusedAsk: ReturnType<typeof vi.fn>;
  const config: TasksHandlerConfig = { defaultCwd: '/tmp' };

  beforeEach(() => {
    traceStore = { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike;
    taskStore = { updateRun: vi.fn() } as unknown as TasksStoreLike;
    onRefusedAsk = vi.fn();
  });

  /** Run one turn over these events and hand back what the run row was written with. */
  async function runTurn(
    events: StreamEvent[],
    reporter: RefusedAskReporter | undefined = onRefusedAsk as RefusedAskReporter
  ): Promise<Record<string, unknown>> {
    const deps: TasksHandlerDeps = {
      agentManager: agentManagerYielding(events),
      traceStore,
      taskStore,
      runningTasks: new AbortRegistry(),
      ...(reporter ? { onRefusedAsk: reporter } : {}),
    };
    await handleTasksMessage('sub', envelopeFor(), undefined, Date.now(), config, deps);
    const calls = vi.mocked(taskStore.updateRun).mock.calls;
    return calls[calls.length - 1]![1] as Record<string, unknown>;
  }

  it('reports every tool the run was refused, with the ids the host needs', async () => {
    await runTurn([
      { type: 'text_delta', data: { text: 'starting' } },
      nobodyThere('Bash'),
      nobodyThere('mcp__dorkos__tasks_delete'),
    ]);

    expect(onRefusedAsk).toHaveBeenCalledTimes(2);
    expect(onRefusedAsk).toHaveBeenNthCalledWith(1, {
      taskId: 'task-1',
      runId: 'run-1',
      refused: { toolName: 'Bash', reason: 'nobody was available to approve this tool' },
    });
    expect(onRefusedAsk).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        refused: expect.objectContaining({ toolName: 'mcp__dorkos__tasks_delete' }),
      })
    );
  });

  it('reports a tool refused thirty times exactly once', async () => {
    // A blocked tool in a retry loop is one fact, not thirty feed rows. The
    // dedupe lives in the shared log both dispatch paths fold their stream
    // through, which is why this path only reports what `observe` answers with.
    await runTurn(Array.from({ length: 30 }, () => nobodyThere('Bash')));

    expect(onRefusedAsk).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for a run that was refused nothing', async () => {
    await runTurn([{ type: 'text_delta', data: { text: 'all done' } }]);

    expect(onRefusedAsk).not.toHaveBeenCalled();
  });

  it('still leads the run summary with the refusal, reporter or not', async () => {
    // The report is an addition; the record that was already there must survive
    // it, including for a host that wires no reporter at all.
    const written = await runTurn(
      [nobodyThere('Bash'), { type: 'text_delta', data: { text: 'x' } }],
      undefined
    );

    expect(written.status).toBe('completed');
    expect(String(written.outputSummary)).toContain('Bash');
  });
});
