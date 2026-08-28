/**
 * How long task run history and the dispatch-dedup log are kept, and the sweep
 * that enforces it (DOR-1482).
 *
 * Both used to be pruned exactly once, at startup, which is the wrong cadence
 * for a server that is meant to stay up: a task on a per-minute schedule writes
 * ~43,000 run rows and ~43,000 dedup rows a month, and a machine that is never
 * restarted never sheds any of them. `GET /api/tasks/runs` then sorts the lot on
 * every read.
 *
 * @module services/tasks/run-retention
 */
import type { TaskStore } from './task-store.js';
import { createTaggedLogger, logError } from '../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/** Retention window for the dispatch-dedup log — generous; a tick only needs seconds. */
export const DISPATCH_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How often retention runs. Far more often than retention needs, and still
 * cheap: a handful of indexed deletes per task.
 */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Shed run history past `retentionCount` per task, and dispatch-dedup rows past
 * their TTL.
 *
 * Contained per task, and again for the dedup log. This runs on a timer
 * forever, so an escaping throw would not retry the work — it would disable
 * retention for the life of the process, which is the failure mode the
 * reconciler next door was already bitten by.
 *
 * Safe to run in every process, leader or not: the deletes are idempotent and
 * keyed on age, so N processes sharing a `dorkHome` pruning the same rows is
 * duplicate work rather than a conflict. Tying housekeeping to leadership would
 * mean a machine whose leader is busy keeps its table forever.
 *
 * @param store - The store to prune.
 * @param retentionCount - How many runs to keep per task.
 */
export function pruneRunHistory(store: TaskStore, retentionCount: number): void {
  for (const task of store.getTasks()) {
    try {
      store.pruneRuns(task.id, retentionCount);
    } catch (err) {
      logger.error(`could not prune run history for "${task.name}"`, logError(err));
    }
  }

  try {
    store.pruneDispatchLog(DISPATCH_LOG_TTL_MS);
  } catch (err) {
    logger.error('could not prune the dispatch log', logError(err));
  }
}
