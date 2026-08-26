import { describe, it, expect, beforeEach, vi } from 'vitest';
import { emitTerminalRunActivity } from '../run-activity.js';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import type { ActivityService } from '../../activity/activity-service.js';
import type { Task, TaskRun } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';

function taskInput(name: string): CreateTaskStoreInput {
  return {
    name,
    description: 'test',
    prompt: 'test',
    agentId: 'agent-1',
    filePath: `/tmp/tasks/${name}/SKILL.md`,
  };
}

describe('emitTerminalRunActivity (DOR-1573)', () => {
  let store: TaskStore;
  let task: Task;
  let emit: ReturnType<typeof vi.fn>;
  let activityService: ActivityService;

  beforeEach(() => {
    store = new TaskStore(createTestDb());
    task = store.createTask(taskInput('digest'));
    emit = vi.fn();
    activityService = { emit } as unknown as ActivityService;
  });

  /** A terminal run row of the given status, reconstructed the way the hook sees it. */
  function terminalRun(status: TaskRun['status'], fields: { error?: string } = {}): TaskRun {
    const run = store.createRun(task.id, 'scheduled');
    return store.updateRun(run.id, { status, durationMs: 1000, ...fields })!;
  }

  it('emits run_success for a completed run, with duration in the summary', () => {
    emitTerminalRunActivity(activityService, task, terminalRun('completed'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'tasks.run_success', resourceLabel: 'digest' })
    );
  });

  it('emits run_failed and carries the error into metadata', () => {
    emitTerminalRunActivity(activityService, task, terminalRun('failed', { error: 'nope' }));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'tasks.run_failed', metadata: { error: 'nope' } })
    );
  });

  it('does NOT emit for a cancelled run', () => {
    emitTerminalRunActivity(
      activityService,
      task,
      terminalRun('cancelled', { error: 'Run cancelled' })
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('does NOT emit for a skipped run', () => {
    // A skipped tick is written straight to a terminal row, never through
    // updateRun, so in practice it never reaches this hook — but the guard must
    // exclude it regardless, since its status is outside the emitted union.
    emitTerminalRunActivity(activityService, task, terminalRun('skipped'));
    expect(emit).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no activity service', () => {
    expect(() => emitTerminalRunActivity(null, task, terminalRun('completed'))).not.toThrow();
  });

  it('is a no-op when the hook could not read the task', () => {
    emitTerminalRunActivity(activityService, null, terminalRun('completed'));
    expect(emit).not.toHaveBeenCalled();
  });
});
