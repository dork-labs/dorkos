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

  describe('syncTask', () => {
    it('registers a task that is enabled and active', () => {
      const task = store.createTask(taskInput({ name: 'nightly', cron: '0 2 * * *' }));

      registrar.syncTask(task.id);

      expect(scheduler.cronFor(task.id)).toBe('0 2 * * *');
    });

    it('re-registers with the cron the row now holds', () => {
      const task = store.createTask(taskInput({ name: 'nightly', cron: '0 2 * * *' }));
      registrar.syncTask(task.id);

      store.updateTask(task.id, { cron: '0 5 * * *' });
      registrar.syncTask(task.id);

      expect(scheduler.cronFor(task.id)).toBe('0 5 * * *');
    });

    it('unregisters a task that has been disabled', () => {
      const task = store.createTask(taskInput({ name: 'nightly', cron: '0 2 * * *' }));
      registrar.syncTask(task.id);

      store.updateTask(task.id, { enabled: false });
      registrar.syncTask(task.id);

      expect(scheduler.cronFor(task.id)).toBeNull();
      expect(scheduler.unregistered).toContain(task.id);
    });

    it('unregisters a task waiting for approval — a proposal must not fire', () => {
      const task = store.createTask(taskInput({ name: 'proposed', cron: '0 2 * * *' }));
      registrar.syncTask(task.id);

      store.updateTask(task.id, { status: 'pending_approval' });
      registrar.syncTask(task.id);

      expect(scheduler.cronFor(task.id)).toBeNull();
    });

    it('unregisters a task paused because its file went away', () => {
      const task = store.createTask(taskInput({ name: 'vanished', cron: '0 2 * * *' }));
      registrar.syncTask(task.id);

      store.markRemovedByFilePath(task.filePath);
      registrar.syncTask(task.id);

      expect(scheduler.cronFor(task.id)).toBeNull();
    });

    // A live job whose row is gone is the worst of the states: it still fires,
    // and the run it tries to record has no schedule to belong to.
    it('unregisters a task whose row has been deleted', () => {
      const task = store.createTask(taskInput({ name: 'deleted', cron: '0 2 * * *' }));
      registrar.syncTask(task.id);

      store.deleteTask(task.id);
      registrar.syncTask(task.id);

      expect(scheduler.cronFor(task.id)).toBeNull();
      expect(scheduler.unregistered).toContain(task.id);
    });

    it('leaves an on-demand task without a job', () => {
      const task = store.createTask(taskInput({ name: 'on-demand' }));

      registrar.syncTask(task.id);

      expect(scheduler.cronFor(task.id)).toBeNull();
    });

    // The boot window: the watcher delivers its first events, and the server is
    // already answering requests, before `schedulerService.start()` runs.
    it('does nothing before the scheduler has started — start() reads the store', () => {
      const notStarted = new FakeScheduler(false);
      const early = new TaskRegistrar({ store, scheduler: notStarted });
      const task = store.createTask(taskInput({ name: 'early', cron: '0 2 * * *' }));

      early.syncTask(task.id);

      expect(notStarted.registered).toHaveLength(0);
      expect(notStarted.unregistered).toHaveLength(0);
    });
  });

  describe('syncTaskByFilePath', () => {
    it('finds the row that claims that exact path and syncs it', () => {
      const task = store.createTask(taskInput({ name: 'by-path', cron: '0 2 * * *' }));

      registrar.syncTaskByFilePath(task.filePath);

      expect(scheduler.cronFor(task.id)).toBe('0 2 * * *');
    });

    it('does nothing for a path no row claims', () => {
      registrar.syncTaskByFilePath('/tmp/tasks/nobody/SKILL.md');

      expect(scheduler.registered).toHaveLength(0);
      expect(scheduler.unregistered).toHaveLength(0);
    });

    // Slugs repeat across the global tasks dir and every project one; only the
    // full path identifies a row.
    it('syncs only the row at that path, never a same-named task elsewhere', () => {
      const mine = store.createTask(
        taskInput({
          name: 'flow-drain',
          cron: '0 2 * * *',
          filePath: '/a/tasks/flow-drain/SKILL.md',
        })
      );
      const theirs = store.createTask(
        taskInput({
          name: 'flow-drain',
          cron: '0 3 * * *',
          filePath: '/b/tasks/flow-drain/SKILL.md',
        })
      );

      registrar.syncTaskByFilePath(mine.filePath);

      expect(scheduler.cronFor(mine.id)).toBe('0 2 * * *');
      expect(scheduler.cronFor(theirs.id)).toBeNull();
    });
  });
});
