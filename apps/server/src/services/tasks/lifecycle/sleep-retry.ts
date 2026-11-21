/**
 * A scheduled run the computer's sleep broke runs once more after it wakes
 * (DOR-3286).
 *
 * A run whose turn breaks while the computer sleeps records that it slept
 * (`withSleepBlame`, on either dispatch path). That run did not fail at its
 * job; it lost the machine under it. So it is tried again, once, on the rules
 * a late fire already follows:
 *
 * - **After a real wake.** The retry waits on the scheduler's {@link WakeSettle},
 *   so it starts only once the computer has stayed awake a couple of minutes.
 *   A retry that started inside the next dark wake would break the same way.
 * - **Only while still due.** Judged by {@link isTooLate}, the rule that
 *   skips a fire the computer slept through: an hour late, or halfway to the
 *   next occurrence, is too late. A daily 09:00 report broken at 09:20 by a lid
 *   closed until 09:40 runs again; an every-15-minutes check does not, because
 *   its next occurrence is the better run.
 * - **Through the same door as a fire.** The retry is handed back to the
 *   scheduler's own dispatch, so every gate a fire passes still applies: the
 *   leader and production gates, a parked or paused agent, a schedule turned
 *   off, the concurrency cap, a sticky task's running turn.
 * - **Once.** A retry the computer's sleep breaks too is not retried again;
 *   its own line says what happened.
 *
 * Only the process that ran (or dispatched) the run decides, and only the
 * leader dispatches, so the retry needs no cross-process claim.
 *
 * @module services/tasks/lifecycle/sleep-retry
 */
import { Cron } from 'croner';
import type { Task, TaskRun } from '@dorkos/shared/types';
import { isSleptDuringRunError } from '@dorkos/shared/schedule-notice-copy';
import type { TaskStore } from '../task-store.js';
import { isTooLate } from '../timing/occurrence.js';
import type { WakeSettle } from '../timing/wake-settle.js';
import { createTaggedLogger } from '../../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/** The fire a retry hands the scheduler's dispatch. */
export interface SleepRetryFire {
  /** When the retry runs. */
  firedAt: Date;
  /** No cron fire is behind it, so nothing was expected. */
  expected: null;
  /** The run the computer's sleep broke; the retry stands for its occurrence. */
  retryOf: TaskRun;
}

/**
 * Try a scheduled run again after the computer wakes, when the computer's
 * sleep is what ended it. Does nothing for any other ending.
 *
 * @param store - Read for how the run ended.
 * @param settle - Holds the retry until the computer has settled after a wake.
 * @param task - The task the run belongs to.
 * @param run - The run that just ended.
 * @param dispatch - The scheduler's dispatch, handed the task and the retry.
 */
export function retryAfterSleep<T extends Pick<Task, 'name' | 'cron' | 'timezone'>>(
  store: Pick<TaskStore, 'getRun'>,
  settle: Pick<WakeSettle, 'run'>,
  task: T,
  run: Pick<TaskRun, 'id' | 'trigger'>,
  dispatch: (task: T, fire: SleepRetryFire) => Promise<unknown>
): void {
  if (run.trigger !== 'scheduled') return;
  const ended = store.getRun(run.id);
  if (ended?.status !== 'failed' || !isSleptDuringRunError(ended.error)) return;
  // The occurrence it stood for; a one-shot run has none, so its own start.
  const due = ended.scheduledFor ?? ended.startedAt;
  if (!due) return;
  const intendedFor = new Date(due);
  const job = task.cron
    ? new Cron(task.cron, { paused: true, timezone: task.timezone ?? undefined })
    : null;
  settle.run((at) => {
    if (isTooLate(job, intendedFor, at)) {
      logger.info(`not retrying "${task.name}" after sleep: it is no longer due`);
      return;
    }
    logger.info(`retrying "${task.name}": the computer slept during run ${ended.id}`);
    return dispatch(task, { firedAt: at, expected: null, retryOf: ended });
  }, task.name);
}
