import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRelayRefusedAskEmitter, emitTerminalRunActivity } from '../run-activity.js';
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

  it('emits run_needs_attention, in words that say what to do about it', () => {
    // The defect (DOR-2101): this exact run used to emit `tasks.run_success`,
    // so the feed reported a schedule that read nothing as healthy.
    emitTerminalRunActivity(
      activityService,
      task,
      terminalRun('needs_attention', {
        error: 'Skipped Bash — nobody was there to approve it on a scheduled run.',
      })
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tasks.run_needs_attention',
        summary: 'digest was refused a tool',
      })
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
});

describe('createRelayRefusedAskEmitter (DOR-1580)', () => {
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

  it('writes the refused-ask entry for a run the relay carried', () => {
    // The whole point of the callback: on an install with an adapter connected
    // the relay path is the one a scheduled run takes, and it holds two ids and
    // no feed. Everything the entry says has to come from the lookup.
    const run = store.createRun(task.id, 'scheduled');
    const report = createRelayRefusedAskEmitter({ taskStore: store, activityService });

    report({ taskId: task.id, runId: run.id, refused: { toolName: 'Bash', reason: 'no surface' } });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tasks.ask_refused',
        actorType: 'tasks',
        actorLabel: 'Scheduler',
        resourceLabel: 'digest',
        summary: 'digest had a Bash command refused',
        metadata: { runId: run.id, toolName: 'Bash', reason: 'no surface' },
      })
    );
  });

  it('stays silent for a run that is gone', () => {
    const report = createRelayRefusedAskEmitter({ taskStore: store, activityService });

    report({ taskId: task.id, runId: 'no-such-run', refused: { toolName: 'Bash' } });

    expect(emit).not.toHaveBeenCalled();
  });

  it('swallows a store that throws rather than failing the run around it', () => {
    // This callback runs inside the relay task handler's main `try`, and that
    // catch marks the run failed and dead-letters the envelope. A database
    // throwing mid-run — a shutdown closing the handle under a live turn — must
    // therefore cost a feed row and nothing else, never turn a run that ran into
    // a dead-lettered failure.
    const throwingStore = {
      getTask: () => {
        throw new Error('The database connection is not open');
      },
      getRun: () => {
        throw new Error('The database connection is not open');
      },
    } as unknown as TaskStore;
    const report = createRelayRefusedAskEmitter({ taskStore: throwingStore, activityService });

    expect(() =>
      report({ taskId: 'task-1', runId: 'run-1', refused: { toolName: 'Bash' } })
    ).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });
});
