/**
 * How a task's run reads when its turn's run ended with nothing reading it
 * (spec `turns-survive-restarts` §7.3, steps 4 to 6; DOR-5496): a run the port
 * never started, and a turn a restart cut, whose scheduler died with the boot
 * that read it. The run record hands such a run back through the scheduler's
 * word source (`WordSource.ended`), and the task's run ends here with the
 * run's ending, once.
 *
 * **Told once.** Within the age bound the task's run ends through
 * `TaskStore.updateRun`, whose terminal consumers are how a schedule tells:
 * its run history, its "run finished" notice and its agent's beat. They hear
 * only a write that moved the run out of `running`, and only once it
 * committed, so a second hand-back writes and tells nothing. Past the bound
 * the ending is written quietly (`markRunsInterrupted`) and nothing wakes.
 *
 * @module services/tasks/execution/task-run-endings
 */
import { RUN_LINE } from '@dorkos/shared/schedule-notice-copy';
import type { TurnRun } from '../../runs/index.js';
import type { RunEndingFields } from '../history/update-run-row.js';
import type { TaskStore } from '../task-store.js';

/** The run row's sentence for each reason the port gives a run that never started. */
const NOT_STARTED: Readonly<Record<string, string>> = {
  start_lost: 'The run did not start: DorkOS restarted before it began.',
  expired: 'The run did not start: it waited too long for a free slot.',
  start_failed: 'The run did not start: DorkOS could not hand it to the agent.',
  agent_paused: 'The run did not start: its agent is paused.',
  desk_not_own: 'The run did not start: its folder belongs to another agent.',
  invalid_agent_path: 'The run did not start: its agent is not registered.',
  account_not_allowed: 'The run did not start: its account may not work in this project.',
  unknown_runtime: 'The run did not start: its runtime is not available here.',
  runtime_mismatch: 'The run did not start: its runtime is not available here.',
};

/**
 * Why a run the port never started did not start, in a sentence for the run row.
 *
 * @param run - The cancelled run; `endingDetail.cancelledBecause` says why.
 */
export function notStartedLine(run: Pick<TurnRun, 'endingDetail'>): string {
  const why = run.endingDetail.cancelledBecause;
  return (why && NOT_STARTED[why]) ?? 'The run did not start.';
}

/**
 * The status and line a task's run ends with, from its turn's run: a start
 * that was lost, a turn a restart cut, or a turn whose `turn_end` was seen
 * before the restart, with the ending it reported.
 *
 * @param run - The turn's run, `cancelled` or `ended`.
 */
export function taskRunEndingOf(run: TurnRun): RunEndingFields {
  if (run.status === 'cancelled') return { status: 'failed', error: notStartedLine(run) };
  switch (run.ending) {
    case 'completed':
      return { status: 'completed', error: null };
    case 'stopped':
      return { status: 'cancelled', error: 'Run cancelled' };
    case 'failed':
    case 'limited':
    case 'refused':
      return {
        status: 'failed',
        error: run.endingDetail.refusal ?? `The run’s turn ended early (${run.ending}).`,
      };
    default:
      // `process_died` or `shutdown`: the notice reads this opening back as
      // "DorkOS restarted during the run" (DOR-4121).
      return { status: 'failed', error: RUN_LINE.serverRestart };
  }
}

/**
 * End a task's run with its turn's run's ending, if it is still running.
 *
 * @param store - The task store.
 * @param taskRunId - The task's run (`pulse_runs.id`).
 * @param run - The turn's run, `cancelled` or `ended`.
 * @param told - False past the age bound: written quietly, nothing wakes.
 */
export function endTaskRun(
  store: Pick<TaskStore, 'updateRun' | 'markRunsInterrupted'>,
  taskRunId: string,
  run: TurnRun,
  told: boolean
): void {
  const ending = taskRunEndingOf(run);
  if (!told) {
    store.markRunsInterrupted([taskRunId], ending);
    return;
  }
  store.updateRun(taskRunId, {
    status: ending.status,
    finishedAt: new Date().toISOString(),
    ...(ending.error !== null ? { error: ending.error } : {}),
  });
}
