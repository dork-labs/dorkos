/**
 * A relay-dispatched run's time limit counts from when its turn starts, not
 * from when it was queued (DOR-4576). The scheduler sends the limit as
 * `timeLimitMs` and an envelope TTL long enough for the wait; the receiver
 * pauses the limit while the turn says it is waiting for a free agent slot.
 * Real timers at a small scale.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope, TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { SLOT_WAIT_STATUS } from '@dorkos/shared/schemas';
import { handleTasksMessage, type TasksHandlerDeps } from '../task-handler.js';
import type { AgentRuntimeLike, TasksStoreLike } from '../types.js';
import type { TraceStoreLike } from '../../../types.js';
import { AbortRegistry } from '../../../lib/abort-registry.js';

const WAIT_WORDS = 'Waiting to start: every agent on this computer is busy.';
const WAIT: StreamEvent = {
  type: 'system_status',
  data: { message: WAIT_WORDS, status: SLOT_WAIT_STATUS },
} as StreamEvent;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A turn that waits `waitMs` for a slot (saying so twice), then works `workMs`. */
function agentQueuedFor(waitMs: number, workMs: number): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* (): AsyncGenerator<StreamEvent> {
        yield WAIT;
        await sleep(waitMs / 2);
        yield WAIT;
        await sleep(waitMs / 2);
        yield { type: 'text_delta', data: { text: 'working' } };
        await sleep(workMs);
        yield { type: 'done', data: { sessionId: 's' } };
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  } as unknown as AgentRuntimeLike;
}

const basePayload = {
  type: 'task_dispatch',
  taskId: 'task-1',
  runId: 'run-1',
  prompt: 'do the thing',
  cwd: '/tmp/project',
  permissionMode: 'acceptEdits',
  taskName: 'Posting',
  cron: '30 20 * * 1',
  trigger: 'scheduled',
  timeLimit: '5m',
} as TaskDispatchPayload;

async function runUnder(
  agentManager: AgentRuntimeLike,
  opts: { ttlMs: number; timeLimitMs?: number }
): Promise<Array<Record<string, unknown>>> {
  const taskStore = { updateRun: vi.fn() } as unknown as TasksStoreLike;
  const deps: TasksHandlerDeps = {
    agentManager,
    traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike,
    taskStore,
    runningTasks: new AbortRegistry(),
  };
  const payload = {
    ...basePayload,
    ...(opts.timeLimitMs !== undefined ? { timeLimitMs: opts.timeLimitMs } : {}),
  };
  const envelope = {
    id: 'msg-1',
    subject: `relay.system.tasks.${payload.taskId}`,
    from: 'relay.system.tasks.scheduler',
    budget: { hopCount: 0, ttl: Date.now() + opts.ttlMs },
    payload,
  } as unknown as RelayEnvelope;
  await handleTasksMessage('sub', envelope, undefined, Date.now(), { defaultCwd: '/tmp' }, deps);
  return vi
    .mocked(taskStore.updateRun)
    .mock.calls.map((call) => call[1] as Record<string, unknown>);
}

describe('a relay-dispatched run queued behind a full computer', () => {
  it('still runs when it waited longer than its limit, and gets its full limit once started', async () => {
    // 900ms in line under a 500ms limit, then 300ms of work; the TTL covers the wait.
    const writes = await runUnder(agentQueuedFor(900, 300), { ttlMs: 5_000, timeLimitMs: 500 });
    expect(writes[writes.length - 1]).toMatchObject({ status: 'completed' });
    expect(writes[writes.length - 1]!.error).toBeUndefined();
    // While it waited, the row said so; once it started, the line was cleared.
    expect(writes).toContainEqual({ outputSummary: WAIT_WORDS });
    expect(writes).toContainEqual({ outputSummary: '' });
  });

  it('still stops a run that runs past its limit once started', async () => {
    const writes = await runUnder(agentQueuedFor(400, 2_000), { ttlMs: 5_000, timeLimitMs: 300 });
    expect(writes[writes.length - 1]).toMatchObject({
      status: 'cancelled',
      error: 'Run stopped after passing its 5m time limit',
    });
  });

  it('never lets the limit outlive the envelope TTL, the hard cap', async () => {
    // A limit far past the TTL, and a turn that never waited: the TTL stops it.
    const writes = await runUnder(agentQueuedFor(0, 2_000), { ttlMs: 400, timeLimitMs: 60_000 });
    expect(writes[writes.length - 1]).toMatchObject({
      status: 'cancelled',
      error: 'Run stopped after passing its 5m time limit',
    });
  });

  it('keeps counting the TTL while the limit is paused for a wait', async () => {
    // A wait longer than the whole envelope: the TTL stops it mid-wait.
    const writes = await runUnder(agentQueuedFor(2_000, 100), { ttlMs: 500, timeLimitMs: 300 });
    expect(writes[writes.length - 1]).toMatchObject({ status: 'cancelled' });
  });

  it('counts the TTL alone for an envelope that carries no limit, as before', async () => {
    const writes = await runUnder(agentQueuedFor(900, 300), { ttlMs: 500 });
    expect(writes[writes.length - 1]).toMatchObject({ status: 'cancelled' });
  });
});
