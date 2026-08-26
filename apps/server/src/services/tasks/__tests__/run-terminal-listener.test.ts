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

  it('emits run_failed with the error, exactly once (no double, no zero)', async () => {
    const task = store.createTask(taskInput('report'));
    const run = store.createRun(task.id, 'scheduled');

    store.updateRun(run.id, { status: 'failed', durationMs: 500, error: 'boom' });
    await flush();

    expect(activityService.emit).toHaveBeenCalledTimes(1);
    expect(activityService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tasks.run_failed',
        metadata: { error: 'boom' },
      })
    );
  });

  it('does NOT emit for a cancelled run — that stays with the path that ended it', async () => {
    // The run row cannot say whether an operator or a deadline cancelled the run,
    // and the two carry different actors, so the emit is left to the dispatch
    // path (which knows) rather than the row-only funnel.
    const task = store.createTask(taskInput('stoppable'));
    const run = store.createRun(task.id, 'scheduled');

    store.updateRun(run.id, { status: 'cancelled', durationMs: 10, error: 'Run cancelled' });
    await flush();

    expect(activityService.emit).not.toHaveBeenCalled();
  });

  it('fires the emit exactly once per run even when the run row is stomped after going terminal', async () => {
    // The terminal guard in updateRun swallows the scheduler's post-publish
    // status:'running' write, so a run that finished on the relay path is not
    // double-counted in the feed.
    const task = store.createTask(taskInput('raced'));
    const run = store.createRun(task.id, 'scheduled');

    store.updateRun(run.id, { status: 'completed', durationMs: 42 });
    store.updateRun(run.id, { status: 'running' }); // DOR-248 stomp — ignored
    store.updateRun(run.id, { status: 'failed', error: 'late' }); // ignored
    await flush();

    expect(activityService.emit).toHaveBeenCalledTimes(1);
    expect(activityService.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'tasks.run_success' })
    );
  });
});
