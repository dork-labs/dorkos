import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { pulseSchedules } from '@dorkos/db';

/** Build a minimal CreateTaskStoreInput with defaults for required fields. */
function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: overrides.prompt ?? 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

describe('TaskStore', () => {
  let store: TaskStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  // === Task CRUD ===

  describe('task CRUD', () => {
    it('starts with empty tasks', () => {
      expect(store.getTasks()).toEqual([]);
    });

    it('creates a task', () => {
      const task = store.createTask(
        taskInput({
          name: 'Daily cleanup',
          description: 'Clean up temp files',
          prompt: 'Clean up temp files',
          cron: '0 2 * * *',
        })
      );

      expect(task.id).toBeDefined();
      expect(task.name).toBe('Daily cleanup');
      expect(task.prompt).toBe('Clean up temp files');
      expect(task.cron).toBe('0 2 * * *');
      expect(task.enabled).toBe(true);
      expect(task.status).toBe('active');
      expect(task.permissionMode).toBe('acceptEdits');
      expect(task.timezone).toBe('UTC');
      expect(task.maxRuntime).toBeNull();
      expect(task.nextRun).toBeNull();
    });

    it('persists tasks in the database', () => {
      store.createTask(
        taskInput({
          name: 'Test',
          description: 'Run tests',
          prompt: 'Run tests',
          cron: '*/5 * * * *',
        })
      );

      // Verify directly via Drizzle query
      const rows = db.select().from(pulseSchedules).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Test');
    });

    it('reads created tasks back', () => {
      store.createTask(taskInput({ name: 'A', prompt: 'a', cron: '* * * * *' }));
      store.createTask(taskInput({ name: 'B', prompt: 'b', cron: '* * * * *' }));

      const all = store.getTasks();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.name)).toEqual(['A', 'B']);
    });

    it('gets a single task by ID', () => {
      const created = store.createTask(taskInput({ name: 'One', prompt: 'p', cron: '* * * * *' }));
      const found = store.getTask(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('One');
    });

    it('returns null for missing task', () => {
      expect(store.getTask('nonexistent')).toBeNull();
    });

    it('updates a task', () => {
      const created = store.createTask(taskInput({ name: 'Old', prompt: 'p', cron: '* * * * *' }));
      const updated = store.updateTask(created.id, { name: 'New', enabled: false });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('New');
      expect(updated!.enabled).toBe(false);
      expect(updated!.prompt).toBe('p');
    });

    it('returns null when updating nonexistent task', () => {
      expect(store.updateTask('nope', { name: 'X' })).toBeNull();
    });

    it('deletes a task', () => {
      const created = store.createTask(taskInput({ name: 'Del', prompt: 'p', cron: '* * * * *' }));
      expect(store.deleteTask(created.id)).toBe(true);
      expect(store.getTasks()).toHaveLength(0);
    });

    it('returns false when deleting nonexistent task', () => {
      expect(store.deleteTask('nope')).toBe(false);
    });
  });

  // === Run CRUD ===

  describe('run CRUD', () => {
    // Helper: create a task so FK constraint is satisfied
    function createTestTask(id?: string) {
      const task = store.createTask(
        taskInput({
          name: `Task ${id ?? 'test'}`,
          prompt: 'test prompt',
          cron: '* * * * *',
        })
      );
      return task.id;
    }

    it('creates a run with running status', () => {
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');
      expect(run.id).toBeDefined();
      expect(run.scheduleId).toBe(taskId);
      expect(run.status).toBe('running');
      expect(run.trigger).toBe('scheduled');
      expect(run.startedAt).toBeDefined();
      expect(run.finishedAt).toBeNull();
    });

    it('gets a run by ID', () => {
      const taskId = createTestTask();
      const created = store.createRun(taskId, 'manual');
      const found = store.getRun(created.id);
      expect(found).not.toBeNull();
      expect(found!.trigger).toBe('manual');
    });

    it('returns null for missing run', () => {
      expect(store.getRun('nonexistent')).toBeNull();
    });

    it('updates run fields', () => {
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');
      const updated = store.updateRun(run.id, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        durationMs: 5000,
        outputSummary: 'All good',
        sessionId: 'session-123',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.durationMs).toBe(5000);
      expect(updated!.outputSummary).toBe('All good');
      expect(updated!.sessionId).toBe('session-123');
    });

    it('returns null when updating nonexistent run', () => {
      expect(store.updateRun('nope', { status: 'failed' })).toBeNull();
    });

    it('lists runs with pagination', () => {
      const taskId = createTestTask();
      for (let i = 0; i < 5; i++) {
        store.createRun(taskId, 'scheduled');
      }

      const all = store.listRuns({ limit: 10 });
      expect(all).toHaveLength(5);

      const page = store.listRuns({ limit: 2, offset: 0 });
      expect(page).toHaveLength(2);

      const page2 = store.listRuns({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
    });

    it('lists runs filtered by task', () => {
      const taskId1 = createTestTask('1');
      const taskId2 = createTestTask('2');
      store.createRun(taskId1, 'scheduled');
      store.createRun(taskId2, 'scheduled');
      store.createRun(taskId1, 'manual');

      const task1Runs = store.listRuns({ taskId: taskId1 });
      expect(task1Runs).toHaveLength(2);

      const task2Runs = store.listRuns({ taskId: taskId2 });
      expect(task2Runs).toHaveLength(1);
    });

    it('gets running runs', () => {
      const taskId = createTestTask();
      const r1 = store.createRun(taskId, 'scheduled');
      store.createRun(taskId, 'scheduled');
      store.updateRun(r1.id, { status: 'completed' });

      const running = store.getRunningRuns();
      expect(running).toHaveLength(1);
    });

    it('counts runs', () => {
      const taskId1 = createTestTask('1');
      const taskId2 = createTestTask('2');
      store.createRun(taskId1, 'scheduled');
      store.createRun(taskId1, 'scheduled');
      store.createRun(taskId2, 'scheduled');

      expect(store.countRuns()).toBe(3);
      expect(store.countRuns(taskId1)).toBe(2);
      expect(store.countRuns(taskId2)).toBe(1);
    });
  });

  // === Retention pruning ===

  describe('pruneRuns', () => {
    function createTestTask() {
      return store.createTask(taskInput({ name: 'Prune Test', prompt: 'test', cron: '* * * * *' }))
        .id;
    }

    it('prunes old runs keeping only retentionCount', () => {
      const taskId = createTestTask();
      for (let i = 0; i < 5; i++) {
        store.createRun(taskId, 'scheduled');
      }

      const pruned = store.pruneRuns(taskId, 2);
      expect(pruned).toBe(3);
      expect(store.countRuns(taskId)).toBe(2);
    });

    it('does not prune other tasks', () => {
      const taskId1 = createTestTask();
      const taskId2 = store.createTask(
        taskInput({ name: 'Other', prompt: 'test', cron: '* * * * *' })
      ).id;

      for (let i = 0; i < 3; i++) {
        store.createRun(taskId1, 'scheduled');
      }
      store.createRun(taskId2, 'scheduled');

      store.pruneRuns(taskId1, 1);
      expect(store.countRuns(taskId1)).toBe(1);
      expect(store.countRuns(taskId2)).toBe(1);
    });

    it('returns 0 when nothing to prune', () => {
      const taskId = createTestTask();
      store.createRun(taskId, 'scheduled');
      expect(store.pruneRuns(taskId, 10)).toBe(0);
    });
  });

  // === Crash recovery ===

  describe('markRunningAsFailed', () => {
    function createTestTask() {
      return store.createTask(
        taskInput({ name: 'Recovery Test', prompt: 'test', cron: '* * * * *' })
      ).id;
    }

    it('marks running runs as failed', () => {
      const taskId = createTestTask();
      store.createRun(taskId, 'scheduled');
      store.createRun(taskId, 'scheduled');

      const changed = store.markRunningAsFailed();
      expect(changed).toBe(2);

      const running = store.getRunningRuns();
      expect(running).toHaveLength(0);

      const runs = store.listRuns();
      expect(runs.every((r) => r.status === 'failed')).toBe(true);
      expect(runs.every((r) => r.error === 'Interrupted by server restart')).toBe(true);
    });

    it('does not affect completed runs', () => {
      const taskId = createTestTask();
      const run = store.createRun(taskId, 'scheduled');
      store.updateRun(run.id, { status: 'completed' });

      const changed = store.markRunningAsFailed();
      expect(changed).toBe(0);

      const found = store.getRun(run.id);
      expect(found!.status).toBe('completed');
    });
  });

  // === Shared Db lifecycle ===

  describe('shared database', () => {
    it('works with a second TaskStore sharing the same db', () => {
      const store2 = new TaskStore(db);
      store.createTask(taskInput({ name: 'From store 1', prompt: 'p', cron: '* * * * *' }));
      const tasks = store2.getTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe('From store 1');
    });
  });

  // === ULID IDs ===

  describe('ID generation', () => {
    it('generates ULID IDs (no UUID hyphens)', () => {
      const task = store.createTask(
        taskInput({ name: 'ULID test', prompt: 'p', cron: '* * * * *' })
      );
      expect(task.id).toMatch(/^[0-9A-Z]{26}$/i);
      expect(task.id).not.toContain('-');

      const run = store.createRun(task.id, 'manual');
      expect(run.id).toMatch(/^[0-9A-Z]{26}$/i);
      expect(run.id).not.toContain('-');
    });
  });

  // === agentId field ===

  describe('agentId field', () => {
    it('creates task with agentId', () => {
      const task = store.createTask(
        taskInput({
          name: 'Agent test',
          prompt: 'test prompt',
          cron: '* * * * *',
          agentId: 'agent-123',
        })
      );
      expect(task.agentId).toBe('agent-123');
    });

    it('defaults agentId to null when not provided', () => {
      const task = store.createTask(
        taskInput({
          name: 'No agent',
          prompt: 'test prompt',
          cron: '* * * * *',
        })
      );
      expect(task.agentId).toBeNull();
    });

    it('preserves agentId on unrelated updates', () => {
      const task = store.createTask(
        taskInput({
          name: 'Preserve agent',
          prompt: 'test prompt',
          cron: '* * * * *',
          agentId: 'agent-789',
        })
      );
      const updated = store.updateTask(task.id, { name: 'Renamed' });
      expect(updated!.agentId).toBe('agent-789');
      expect(updated!.name).toBe('Renamed');
    });

    it('includes agentId in getTasks list', () => {
      store.createTask(
        taskInput({
          name: 'Listed',
          prompt: 'test prompt',
          cron: '* * * * *',
          agentId: 'agent-list',
        })
      );
      const tasks = store.getTasks();
      expect(tasks[0].agentId).toBe('agent-list');
    });
  });

  // === disableTasksByAgentId ===

  describe('disableTasksByAgentId', () => {
    it('disables matching enabled tasks', () => {
      const task = store.createTask(
        taskInput({
          name: 'Agent task',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-1',
        })
      );
      const count = store.disableTasksByAgentId('agent-1');
      expect(count).toBe(1);
      const updated = store.getTask(task.id);
      expect(updated!.enabled).toBe(false);
      expect(updated!.status).toBe('paused');
    });

    it('returns 0 when no matching tasks', () => {
      store.createTask(
        taskInput({
          name: 'Other agent',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-2',
        })
      );
      const count = store.disableTasksByAgentId('nonexistent');
      expect(count).toBe(0);
    });

    it('does not re-disable already disabled tasks', () => {
      store.createTask(
        taskInput({
          name: 'Already disabled',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-3',
          enabled: false,
        })
      );
      const count = store.disableTasksByAgentId('agent-3');
      expect(count).toBe(0);
    });

    it('only disables tasks for the specified agent', () => {
      const s1 = store.createTask(
        taskInput({
          name: 'Agent A',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-a',
        })
      );
      const s2 = store.createTask(
        taskInput({
          name: 'Agent B',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-b',
        })
      );
      store.disableTasksByAgentId('agent-a');
      expect(store.getTask(s1.id)!.enabled).toBe(false);
      expect(store.getTask(s2.id)!.enabled).toBe(true);
    });

    it('disables multiple tasks for the same agent', () => {
      store.createTask(
        taskInput({
          name: 'S1',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-multi',
        })
      );
      store.createTask(
        taskInput({
          name: 'S2',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-multi',
        })
      );
      store.createTask(
        taskInput({
          name: 'S3',
          prompt: 'test',
          cron: '* * * * *',
          agentId: 'agent-multi',
        })
      );
      const count = store.disableTasksByAgentId('agent-multi');
      expect(count).toBe(3);
    });
  });

  // === ISO 8601 timestamps ===

  describe('timestamps', () => {
    it('stores ISO 8601 timestamps', () => {
      const task = store.createTask(taskInput({ name: 'TS test', prompt: 'p', cron: '* * * * *' }));
      expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(task.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      const run = store.createRun(task.id, 'scheduled');
      expect(run.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
