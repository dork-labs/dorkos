/**
 * What a schedule's run history says about it: when it last ran (DOR-2914),
 * and the shape of its reliability figures (DOR-166), which
 * `TaskStore.getScheduleReliability` computes.
 *
 * @module services/tasks/history/run-history
 */
import { max, ne } from 'drizzle-orm';
import { pulseRuns, type Db } from '@dorkos/db';

/**
 * Per-schedule reliability, computed over terminal runs (the
 * `TERMINAL_RUN_STATUSES` set, plus DB-only `timeout` rows).
 * See `TaskStore.getScheduleReliability`.
 */
export interface ScheduleReliability {
  /** The `pulseSchedules.id` this row covers. */
  scheduleId: string;
  /** Count of terminal runs included in this computation. */
  totalRuns: number;
  /** Fraction of terminal runs that ended `completed`, in `[0, 1]`. */
  successRate: number;
  /**
   * 95th percentile run duration in ms, over terminal runs with a recorded
   * `durationMs`. `null` when none do, or the linked better-sqlite3 binary
   * predates the percentile extension (DOR-166).
   */
  p95DurationMs: number | null;
}

/**
 * The newest run start per schedule, keyed by schedule id: what the Tasks
 * list's "Last run" sort orders by (a row's `updatedAt` says when it was last
 * changed, a different question). A skipped tick is not a run: the agent never
 * started. A schedule that never ran is absent.
 *
 * One grouped query for every schedule. Run history is pruned per schedule, so
 * the table it reads stays small.
 *
 * @param db - The DorkOS database.
 */
export function lastRunStarts(db: Db): Map<string, string> {
  const rows = db
    .select({ scheduleId: pulseRuns.scheduleId, startedAt: max(pulseRuns.startedAt) })
    .from(pulseRuns)
    .where(ne(pulseRuns.status, 'skipped'))
    .groupBy(pulseRuns.scheduleId)
    .all();
  return new Map(rows.flatMap((row) => (row.startedAt ? [[row.scheduleId, row.startedAt]] : [])));
}
