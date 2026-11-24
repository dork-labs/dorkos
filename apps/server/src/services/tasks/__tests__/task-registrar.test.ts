/**
 * The registrar's whole job is answering "should this task have a live cron job
 * right now?" from the row, so these cases are the row's states.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { FakeScheduler } from './fake-scheduler.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/types';

/** Build a minimal CreateTaskStoreInput with defaults for required fields. */
function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name}/SKILL.md`,
    ...overrides,
  };
}

describe('TaskRegistrar', () => {
  let db: Db;
  let store: TaskStore;
  let scheduler: FakeScheduler;
  let registrar: TaskRegistrar;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = new FakeScheduler();
    registrar = new TaskRegistrar({ store, scheduler });
  });

  it.each<[string, (task: Task) => void]>([
    ['disabled', (task) => store.updateTask(task.id, { enabled: false })],
    // A proposal must not fire.
    ['waiting for approval', (task) => store.updateTask(task.id, { status: 'pending_approval' })],
    [
      'paused because its file went away',
      (task) => store.fileSync.markRemovedByFilePath(task.filePath),
    ],
    // Pausing leaves `enabled` as the person set it; `status` alone fails the gate.
    ['paused with its agent unregistered (DOR-2082)', () => store.disableTasksByAgentId('agent-1')],
    // A live job whose row is gone still fires, with no schedule to belong to.
    ['deleted', (task) => store.deleteTask(task.id)],
  ])('unregisters a task that is %s', (_label, change) => {
    const task = store.createTask(
      taskInput({ name: 'nightly', cron: '0 2 * * *', agentId: 'agent-1' })
    );
    registrar.syncTask(task.id);
    expect(scheduler.cronFor(task.id)).toBe('0 2 * * *');

    change(task);
    registrar.syncTask(task.id);

    expect(scheduler.cronFor(task.id)).toBeNull();
    expect(scheduler.unregistered).toContain(task.id);
  });

  // The boot window: the watcher delivers events before `start()` runs.
  it('does nothing before the scheduler has started — start() reads the store', () => {
    const notStarted = new FakeScheduler(false);
    const task = store.createTask(taskInput({ name: 'early', cron: '0 2 * * *' }));

    new TaskRegistrar({ store, scheduler: notStarted }).syncTask(task.id);

    expect(notStarted.registered).toHaveLength(0);
    expect(notStarted.unregistered).toHaveLength(0);
  });

  // Slugs repeat across the global tasks dir and every project one.
  it('syncTaskByFilePath syncs only the row at that path, never a same-named task elsewhere', () => {
    const mine = store.createTask(
      taskInput({ name: 'flow-drain', cron: '0 2 * * *', filePath: '/a/flow-drain/SKILL.md' })
    );
    const theirs = store.createTask(
      taskInput({ name: 'flow-drain', cron: '0 3 * * *', filePath: '/b/flow-drain/SKILL.md' })
    );

    registrar.syncTaskByFilePath(mine.filePath);

    expect(scheduler.cronFor(mine.id)).toBe('0 2 * * *');
    expect(scheduler.cronFor(theirs.id)).toBeNull();
  });
});
