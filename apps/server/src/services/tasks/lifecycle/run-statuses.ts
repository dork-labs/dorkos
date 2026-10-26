/**
 * Which run statuses are over: the state machine `TaskStore` guards writes
 * with, lifted out of the store so the rule reads on its own.
 *
 * @module services/tasks/lifecycle/run-statuses
 */
import type { TaskRunStatus } from '@dorkos/shared/types';

/**
 * Statuses that end a run's lifecycle. Once a run reaches one of these, its
 * outcome is immutable — no later write (a delayed dispatch acknowledgement,
 * a duplicate handler callback, a restart sweep) may change it. This is the
 * state-machine guard behind DOR-248: synchronous in-process relay delivery
 * can let a handler record `completed` before the publisher's own
 * post-publish `updateRun(..., { status: 'running' })` runs, so the guard
 * has to live in the store's own write (`TaskStore.updateRun`) — reordering
 * the caller only fixes the one call site.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<TaskRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  // A run that ran and was refused a tool it reached for (DOR-3123). It is
  // over, and it is not a failure — it was not allowed to do all of its job.
  'needs_attention',
  // A skipped tick never started, so it is over the instant it is written
  // (DOR-1482) — and being terminal is what stops anything from later
  // "finishing" a run that was never run.
  'skipped',
]);

/**
 * Whether a run status is terminal (see {@link TERMINAL_RUN_STATUSES}).
 *
 * @param status - The run status to classify.
 */
export function isTerminalRunStatus(status: TaskRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Every status that means a run is OVER, for queries that must not act on a run
 * that is still going.
 *
 * The terminal set plus `timeout`, which exists only in the DB column's enum:
 * no writer produces it today and the shared `TaskRunStatus` omits it, but a row
 * carrying it is plainly finished, and both readers below would otherwise treat
 * it as live for ever.
 */
export const FINISHED_RUN_STATUSES = [...TERMINAL_RUN_STATUSES, 'timeout' as const];
