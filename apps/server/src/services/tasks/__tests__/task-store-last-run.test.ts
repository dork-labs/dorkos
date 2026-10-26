/**
 * When each schedule last started a run (DOR-2914): what the Tasks list sorts
 * "Last run" by. Before this it sorted by the row's `updatedAt`, which says
 * when the schedule was last changed, not when it last ran.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { pulseRuns, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';

/** A minimal task input with the required fields filled in. */
function taskInput(name: string): CreateTaskStoreInput {
  return {
    name,
    description: 'test',
    prompt: 'test',
    cron: '* * * * *',
    filePath: `/tmp/tasks/${name.toLowerCase()}/SKILL.md`,
  };
}

describe('TaskStore#lastRunStarts', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  /** Start a run at a given time, in a given status. */
  function runAt(taskId: string, startedAt: string, status: 'completed' | 'skipped' = 'completed') {
    const run = store.createRun(taskId, 'scheduled');
    db.update(pulseRuns).set({ startedAt, status }).where(eq(pulseRuns.id, run.id)).run();
  }

  it('answers the newest start per schedule, and nothing for one that never ran', () => {
    const a = store.createTask(taskInput('A'));
    const b = store.createTask(taskInput('B'));
    const never = store.createTask(taskInput('Never'));
    runAt(a.id, '2026-10-01T08:00:00.000Z');
    runAt(a.id, '2026-10-03T08:00:00.000Z');
    runAt(a.id, '2026-10-02T08:00:00.000Z');
    runAt(b.id, '2026-09-30T08:00:00.000Z');

    const history = store.runHistory();

    expect(history(a.id).lastRunAt).toBe('2026-10-03T08:00:00.000Z');
    expect(history(b.id).lastRunAt).toBe('2026-09-30T08:00:00.000Z');
    expect(history(never.id).lastRunAt).toBeNull();
  });

  it('does not count a skipped tick, since the agent never started', () => {
    const a = store.createTask(taskInput('A'));
    runAt(a.id, '2026-10-01T08:00:00.000Z');
    runAt(a.id, '2026-10-05T08:00:00.000Z', 'skipped');

    expect(store.runHistory()(a.id).lastRunAt).toBe('2026-10-01T08:00:00.000Z');
  });
});
