import type { TaskRun } from '@dorkos/shared/types';

/** What the newest runs say about each schedule right now. */
export interface RecentRunsSummary {
  /** Schedules with a run going, in the order their runs started (newest first). */
  running: string[];
  /**
   * Schedules whose latest run failed or was blocked. A blocked run did
   * nothing, every tool it reached for refused (DOR-2101), so it counts as a
   * failure here exactly as it does on the health chip.
   */
  failed: string[];
}

/**
 * Read each schedule's latest run out of a newest-first list of runs.
 *
 * Only the latest run per schedule counts: a schedule that failed on Monday
 * and ran fine on Tuesday is fine. A schedule whose latest run is older than
 * the list reaches is not mentioned at all, which errs towards quiet.
 *
 * @param runs - Runs across every schedule, newest first (the server's order).
 */
export function summarizeRecentRuns(runs: readonly TaskRun[]): RecentRunsSummary {
  const seen = new Set<string>();
  const running: string[] = [];
  const failed: string[] = [];
  for (const run of runs) {
    // A running run is always the schedule's latest, but a schedule can have a
    // manual run going beside a scheduled one, so it is named once.
    if (run.status === 'running') {
      if (!running.includes(run.scheduleId)) running.push(run.scheduleId);
      seen.add(run.scheduleId);
      continue;
    }
    if (seen.has(run.scheduleId)) continue;
    seen.add(run.scheduleId);
    if (run.status === 'failed' || run.status === 'blocked') failed.push(run.scheduleId);
  }
  return { running, failed };
}
