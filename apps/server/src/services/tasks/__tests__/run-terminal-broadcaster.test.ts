import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

// The broadcaster fans onto the /api/events SSE stream — mock the fan-out so we
// can assert exactly what it emits, and when.
vi.mock('../../core/event-fan-out.js', () => ({
  eventFanOut: { broadcast: vi.fn() },
}));

import { eventFanOut } from '../../core/event-fan-out.js';
import { broadcastRunTerminal } from '../run-terminal-broadcaster.js';

function taskInput(name: string): CreateTaskStoreInput {
  return {
    name,
    description: 'test',
    prompt: 'test',
    agentId: 'agent-1',
    filePath: `/tmp/tasks/${name}/SKILL.md`,
  };
}

/** Wait for the fire-and-forget queueMicrotask terminal-hook dispatch to settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

/** All broadcast calls whose event name is `task_run_failed`. */
function failCalls() {
  return vi.mocked(eventFanOut.broadcast).mock.calls.filter(([name]) => name === 'task_run_failed');
}

describe('broadcastRunTerminal via the TaskStore run-terminal hook (DOR-403)', () => {
  let store: TaskStore;
  let db: Db;

  beforeEach(() => {
    vi.mocked(eventFanOut.broadcast).mockClear();
    db = createTestDb();
    store = new TaskStore(db);
    // Mirror the index.ts wiring: the terminal hook drives the broadcaster.
    store.setOnRunTerminal((run) => broadcastRunTerminal(run));
  });

  it('broadcasts task_run_failed on a direct scheduler-side failure', async () => {
    const task = store.createTask(taskInput('direct-fail'));
    const created = store.createRun(task.id, 'scheduled');

    store.updateRun(created.id, { status: 'failed', durationMs: 0, error: 'boom' });
    await flush();

    expect(failCalls()).toHaveLength(1);
    expect(failCalls()[0][1]).toMatchObject({ runId: created.id, scheduleId: task.id });
  });

  it('broadcasts task_run_failed on a store-level updateRun("failed") — the relay receiver path', async () => {
    const task = store.createTask(taskInput('relay-fail'));
    const created = store.createRun(task.id, 'manual');
    // The relay receiver (packages/relay task-handler) finalizes a delivered run
    // by writing the terminal status straight to TaskStore, exactly like this.
    store.updateRun(created.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: 'agent turn failed',
    });
    await flush();

    expect(failCalls()).toHaveLength(1);
    expect(failCalls()[0][1]).toMatchObject({ runId: created.id, scheduleId: task.id });
  });

  it('does NOT broadcast on a successful terminal run', async () => {
    const task = store.createTask(taskInput('success'));
    const created = store.createRun(task.id, 'scheduled');

    store.updateRun(created.id, { status: 'completed', durationMs: 1000 });
    await flush();

    expect(failCalls()).toHaveLength(0);
  });

  it('does NOT broadcast on a cancelled terminal run', async () => {
    const task = store.createTask(taskInput('cancelled'));
    const created = store.createRun(task.id, 'manual');

    store.updateRun(created.id, { status: 'cancelled' });
    await flush();

    expect(failCalls()).toHaveLength(0);
  });

  it('does NOT re-broadcast on a re-observation of an already-terminal run', async () => {
    const task = store.createTask(taskInput('reobserve'));
    const created = store.createRun(task.id, 'scheduled');

    // First failure fires once.
    store.updateRun(created.id, { status: 'failed', error: 'boom' });
    // Later stomps on the already-terminal run are guarded no-ops — no re-fire.
    store.updateRun(created.id, { status: 'running' });
    store.updateRun(created.id, { status: 'failed', error: 'late' });
    await flush();

    expect(failCalls()).toHaveLength(1);
  });
});
