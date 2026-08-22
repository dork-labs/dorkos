/**
 * "Run it once" — approval by demonstration.
 *
 * The signature move of the approval card: before committing to a timer that
 * will fire unattended forever, run the proposed prompt ONCE, supervised, and
 * look at what it did. Nothing is armed, no status changes, and the standing
 * proposal is untouched — the server's manual trigger already executes a run in
 * its own isolated session and records it in the run history, so this is a read
 * of machinery that exists rather than a second way to run a task.
 *
 * @module features/schedule-approval/model/use-schedule-test-run
 */
import { useCallback, useState } from 'react';
import type { TaskRun } from '@dorkos/shared/types';
import { useTaskRuns, useTriggerTask } from '@/layers/entities/tasks';

/**
 * How many recent runs to read while looking for the one we started.
 *
 * Small on purpose: the run is found by id, so this only has to be wide enough
 * that a busy schedule cannot bury a just-started run under newer ones before
 * the first read lands.
 */
const RUN_LOOKUP_LIMIT = 10;

/** Where a test run has got to. */
export type ScheduleTestRunPhase = 'idle' | 'running' | 'finished' | 'failed' | 'stopped';

/** What {@link useScheduleTestRun} answers with. */
export interface ScheduleTestRunState {
  /** Where the run has got to, or `idle` when none has been asked for. */
  phase: ScheduleTestRunPhase;
  /** The run itself, once the history has it. Null until then. */
  run: TaskRun | null;
  /**
   * What went wrong, in whatever words the server gave — the run's own error,
   * or the refusal of the trigger request itself. Null when nothing has.
   */
  error: string | null;
  /** Start one supervised run. A no-op while one is already in flight. */
  start: () => void;
}

/**
 * Run a proposed schedule once, and watch what happens.
 *
 * **Identified by id, never by recency.** The trigger answers with the run id it
 * created, and that id is what the history is searched for. Picking "the newest
 * manual run" instead would attach the card's result strip to a run somebody
 * started from the Tasks page in another tab — the card would then report an
 * outcome that was never its own.
 *
 * The run list only starts being read once there is a run to look for, and it
 * polls itself while anything in it is still running (`useTaskRuns`), so a
 * finished run settles the strip without this hook owning a timer.
 *
 * @param taskId - The schedule to run once.
 */
export function useScheduleTestRun(taskId: string): ScheduleTestRunState {
  const trigger = useTriggerTask();
  const [runId, setRunId] = useState<string | null>(null);

  const { data: runs } = useTaskRuns(
    { scheduleId: taskId, limit: RUN_LOOKUP_LIMIT },
    runId !== null
  );
  const run = runId === null ? null : (runs?.find((candidate) => candidate.id === runId) ?? null);

  const start = useCallback(() => {
    if (trigger.isPending) return;
    trigger.mutate(taskId, {
      onSuccess: ({ runId: started }) => setRunId(started),
    });
  }, [taskId, trigger]);

  return {
    phase: testRunPhase({
      triggering: trigger.isPending,
      triggerFailed: trigger.isError,
      runId,
      run,
    }),
    run,
    error: run?.error ?? triggerRefusal(trigger.isError, trigger.error),
    start,
  };
}

/** What the phase is derived from. */
interface PhaseInput {
  /** True while the trigger request itself is in flight. */
  triggering: boolean;
  /** True when the trigger request was refused. */
  triggerFailed: boolean;
  /** The run id the trigger handed back, or null before it did. */
  runId: string | null;
  /** The run row, once the history holds it. */
  run: TaskRun | null;
}

/**
 * Where the test run has got to.
 *
 * **A run we have an id for but no row yet counts as running**, which is the
 * ordinary case for the second between the trigger answering and the history
 * refetching. Reporting `idle` there would blink the button back to "Run it
 * once" and invite a second run; reporting `finished` would claim an outcome
 * nothing has yet.
 *
 * @param input - The trigger's state and whatever the history knows.
 */
function testRunPhase({ triggering, triggerFailed, runId, run }: PhaseInput): ScheduleTestRunPhase {
  if (triggering) return 'running';
  if (runId === null) return triggerFailed ? 'failed' : 'idle';
  if (run === null || run.status === 'running') return 'running';
  if (run.status === 'completed') return 'finished';
  if (run.status === 'cancelled') return 'stopped';
  return 'failed';
}

/**
 * The trigger's refusal in the words it came with.
 *
 * @param failed - Whether the trigger request was refused.
 * @param error - Whatever the mutation threw.
 * @returns A readable message, or null when nothing was refused.
 */
function triggerRefusal(failed: boolean, error: unknown): string | null {
  if (!failed) return null;
  return error instanceof Error && error.message !== '' ? error.message : null;
}
