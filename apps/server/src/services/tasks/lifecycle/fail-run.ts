/**
 * End a run that never started, or close one that was skipped, with the reason
 * on the row a person reads. Out of the scheduler so it can shrink (DOR-4315).
 *
 * @module services/tasks/lifecycle/fail-run
 */
import type { TaskRun } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import type { TaskStore } from '../task-store.js';

/**
 * End a run that never started. The activity-feed event rides the TaskStore
 * run-terminal hook (DOR-1573), fired by this `updateRun('failed')`: the one
 * funnel both dispatch paths share.
 *
 * @param store - The task store.
 * @param run - The run row, already opened.
 * @param err - Why it could not start.
 */
export function failRun(store: Pick<TaskStore, 'updateRun'>, run: TaskRun, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  store.updateRun(run.id, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    error: message,
  });
  logger.error(`run ${run.id} could not start: ${message}`);
}

/**
 * Close a run that was opened but skipped, with the reason on its row, the
 * way a skipped cron tick's row reads (DOR-4315: a one-shot task's one run).
 *
 * @param store - The task store.
 * @param run - The run row, already opened.
 * @param reason - Why it was skipped.
 */
export function skipRun(store: Pick<TaskStore, 'updateRun'>, run: TaskRun, reason: string): void {
  store.updateRun(run.id, {
    status: 'skipped',
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    error: reason,
  });
}
