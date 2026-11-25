import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { createRunTerminalListener } from '../run-terminal-broadcaster.js';
import type { ActivityService } from '../../activity/activity-service.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

// Isolate the activity consumer from the completion notification, whose
// `notify()` reaches the relay pipeline and is covered by its own tests. The
// Pulse broadcast (`broadcastRunTerminal`) stays real: it only fans a
// `task_run_failed` event to SSE subscribers, a no-op with none attached, and
// it lives in this same module as the listener under test.
vi.mock('../../notifications/emitters/run-completed.js', () => ({
  notifyRunCompleted: vi.fn().mockResolvedValue(undefined),
}));

function taskInput(name: string): CreateTaskStoreInput {
  return {
    name,
    description: 'test',
    prompt: 'test',
    agentId: 'agent-1',
    filePath: `/tmp/tasks/${name}/SKILL.md`,
  };
}

/** Wait for the fire-and-forget queueMicrotask dispatch to settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('run-terminal listener → activity feed (DOR-1573)', () => {
  let store: TaskStore;
  let db: Db;
  let activityService: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    activityService = { emit: vi.fn() };
    store.setOnRunTerminal(
      createRunTerminalListener(activityService as unknown as ActivityService)
    );
  });

  it('emits run_success for a run finished by a terminal updateRun (the relay receiver path)', async () => {
    // A relay-delivered run is finalized by the RECEIVER writing its status
    // through `TaskStore#updateRun` — exactly this call. Before DOR-1573 that
    // write emitted nothing to the activity feed, so a finished relay run reached
    // the feed only on the next poll. Now the run-terminal hook carries the emit.
    const task = store.createTask(taskInput('nightly'));
    const run = store.createRun(task.id, 'scheduled');

    store.updateRun(run.id, { status: 'completed', durationMs: 1234 });
    await flush();

    expect(activityService.emit).toHaveBeenCalledTimes(1);
    expect(activityService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tasks.run_success',
        resourceId: task.id,
        resourceLabel: 'nightly',
      })
    );
  });
});

describe('run-terminal listener → one notice per failing streak (DOR-3123)', () => {
  it('hands the notifier how long the schedule has been failing', async () => {
    const { notifyRunCompleted } = await import('../../notifications/emitters/run-completed.js');
    vi.mocked(notifyRunCompleted).mockClear();
    const store = new TaskStore(createTestDb());
    const streakOf = vi.fn(() => 2);
    store.setOnRunTerminal(createRunTerminalListener(null, undefined, streakOf));
    const task = store.createTask(taskInput('health'));
    const run = store.createRun(task.id, 'scheduled');

    store.updateRun(run.id, { status: 'needs_attention', refusedTools: ['Bash'] });
    await flush();

    expect(streakOf).toHaveBeenCalledWith(task.id);
    expect(notifyRunCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: run.id }),
      expect.anything(),
      2
    );
  });
});
