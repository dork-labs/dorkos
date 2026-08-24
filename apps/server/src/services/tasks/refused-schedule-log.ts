/**
 * Saying that a task's schedule cannot be run — at most once an hour per task.
 *
 * Lifted out of `task-scheduler-service.ts` (DOR-1482): it is a small piece of
 * state with one job, and that file is over the size a person can hold in their
 * head. Nothing about the damping changed in the move.
 *
 * @module services/tasks/refused-schedule-log
 */
import type { Task } from '@dorkos/shared/types';
import { createTaggedLogger, logError } from '../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/**
 * How long one unschedulable task stays quiet after it has been reported.
 *
 * Matches `FAILURE_LOG_WINDOW_MS` in `task-reconciler.ts`, and for the same
 * reason: the reconciler's 5-minute pass re-syncs every task file forever, so
 * an undamped refusal is 288 identical lines a day. One line an hour keeps a
 * standing fault visible at a volume that reads.
 */
const REFUSED_SCHEDULE_LOG_WINDOW_MS = 60 * 60 * 1000;

/** What is remembered about one task's refused schedule. */
interface RefusedSchedule {
  /** The cron + timezone that was refused, so a DIFFERENT bad schedule reads as news. */
  signature: string;
  lastLoggedAt: number;
  /** Byte-identical recurrences swallowed since the last log. */
  suppressed: number;
}

/** One entry per task whose schedule croner refused, damping the log. */
export class RefusedScheduleLog {
  private seen = new Map<string, RefusedSchedule>();

  /**
   * Say that a task's schedule cannot be run — at most once an hour per task.
   *
   * The log is the ONLY place this surfaces: the row keeps the schedule it was
   * given and the cockpit keeps showing it, so an operator looking at a task
   * that never fires needs this line to explain why. Giving the row a visible
   * "broken" state needs a column and a screen that do not exist yet.
   *
   * Which is exactly why it has to be damped. The reconciler re-upserts every
   * task file every five minutes and syncs each one through the registrar, so
   * an undamped line here writes 288 identical stack traces a day for one typo
   * — burying the failures an operator actually needs to see. This is the same
   * hazard `TaskReconciler.report` damps on its own timer, and the same one
   * `TaskStore.upsertFromFile` damps for a refused permission grant.
   *
   * The first occurrence of any distinct refusal always logs, in full and at
   * `error`. Keyed on the SCHEDULE, not just the task, for the reason
   * `upsertFromFile` gives: a task re-edited into a *different* bad schedule is
   * a new fault, and must not be silenced by the one before it. When the window
   * closes, a standing fault logs again carrying what it swallowed, so it reads
   * as standing rather than as a fresh one-off.
   *
   * @param task - The task whose schedule croner refused.
   * @param timezone - The timezone actually passed to croner, if any.
   * @param err - What croner threw.
   */
  report(task: Task, timezone: string | undefined, err: unknown): void {
    // JSON rather than a joined string, for the reason `TaskReconciler.report`
    // gives: a delimiter is only unambiguous if it cannot appear in the parts.
    const signature = JSON.stringify([task.cron, timezone ?? null]);
    const now = Date.now();
    const seen = this.seen.get(task.id);

    if (seen?.signature === signature && now - seen.lastLoggedAt < REFUSED_SCHEDULE_LOG_WINDOW_MS) {
      seen.suppressed++;
      return;
    }

    const repeats = seen?.signature === signature ? seen.suppressed : 0;
    const stillFailing =
      repeats > 0
        ? ` (still failing; ${repeats} identical ${repeats === 1 ? 'report' : 'reports'} suppressed in the last hour)`
        : '';
    logger.error(
      `task "${task.name}" has a schedule DorkOS cannot run (cron "${task.cron}"` +
        `${timezone ? `, timezone "${timezone}"` : ''}) — it will not fire until the schedule is fixed` +
        stillFailing,
      logError(err)
    );
    this.seen.set(task.id, { signature, lastLoggedAt: now, suppressed: 0 });
  }
  /** Forget a task's refusal, so its next one is news again. */
  clear(taskId: string): void {
    this.seen.delete(taskId);
  }
}
