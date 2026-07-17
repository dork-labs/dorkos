/**
 * Isolated from task-store.test.ts because it mocks `hasPercentileSupport`
 * for the whole file (DOR-166) -- verifies that
 * TaskStore#getScheduleReliability() degrades gracefully on a
 * better-sqlite3 binary that predates the percentile extension
 * (pre-12.10), rather than crashing when `percentile_cont()` isn't
 * callable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

vi.mock('@dorkos/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dorkos/db')>();
  return {
    ...actual,
    hasPercentileSupport: vi.fn(() => false),
  };
});

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

describe('TaskStore#getScheduleReliability — percentile feature-detection fallback', () => {
  let store: TaskStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  it('never crashes and returns a null p95 when percentile_cont() is unavailable', () => {
    const task = store.createTask(taskInput({ name: 'Fallback', prompt: 'x', cron: '* * * * *' }));
    const run1 = store.createRun(task.id, 'scheduled');
    store.updateRun(run1.id, { status: 'completed', durationMs: 100 });
    const run2 = store.createRun(task.id, 'scheduled');
    store.updateRun(run2.id, { status: 'completed', durationMs: 200 });

    let result: ReturnType<TaskStore['getScheduleReliability']> | undefined;
    expect(() => {
      result = store.getScheduleReliability();
    }).not.toThrow();

    expect(result).toHaveLength(1);
    // Success rate has no dependency on the percentile extension.
    expect(result![0].successRate).toBe(1);
    expect(result![0].totalRuns).toBe(2);
    // The percentile column fails soft to null instead of throwing.
    expect(result![0].p95DurationMs).toBeNull();
  });
});
