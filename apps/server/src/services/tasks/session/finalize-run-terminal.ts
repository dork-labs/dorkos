/** One terminal publication for a run in this process, after its slot is let go. */
import type { Task, TaskRun } from '@dorkos/shared/types';
import {
  type createRefusedAskLog,
  refusedToolNames,
  withRefusedAsks,
} from '@dorkos/shared/run-refusals';
import { withSleepBlame } from '@dorkos/shared/schedule-notice-copy';
import type { TaskStore } from '../task-store.js';
import type { RunAccounting } from '../run-accounting.js';
import type { ActivityService } from '../../activity/activity-service.js';
import { emitRunActivity } from '../run-activity.js';
import type { RunDeadline } from '../timing/wake-settle.js';

type Terminal = Parameters<TaskStore['updateRun']>[1];
type Refusals = ReturnType<typeof createRefusedAskLog>;
interface FailureInput {
  sessionId: string;
  startTime: number;
  error: unknown;
  outputSummary: string;
  refusals: Refusals;
}
/** Construct the existing failed body result, without publishing a row or resolving an alias. */
export function failedRunTerminal(input: FailureInput): Terminal {
  const durationMs = Date.now() - input.startTime;
  const errorMsg = input.error instanceof Error ? input.error.message : String(input.error);
  return {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    durationMs,
    outputSummary: withRefusedAsks(input.refusals.summaryLine(), input.outputSummary.slice(0, 500)),
    error: errorMsg,
    refusedTools: refusedToolNames(input.refusals.all()),
    sessionId: input.sessionId,
  };
}
interface FinalizeInput extends Pick<FailureInput, 'sessionId' | 'startTime'> {
  task: Task;
  run: TaskRun;
  terminal: Terminal | undefined;
  stop: Pick<RunDeadline, 'cancel' | 'justWoke'>;
  agentManager: { getInternalSessionId(sessionId: string): string | undefined };
  store: Pick<TaskStore, 'updateRun'>;
  runs: Pick<RunAccounting, 'release'>;
  activityService: ActivityService | null;
  emitCancellation: boolean;
}
/**
 * Let go of the run's slot and time limit, then publish its one result, under
 * the id the runtime ran its chat as.
 */
export async function finalizeRunTerminal(input: FinalizeInput): Promise<void> {
  let terminal = input.terminal;
  try {
    input.stop.cancel();
  } finally {
    input.runs.release(input.run.id);
  }
  if (terminal) {
    // A failure just after the computer woke from a sleep during the run is put
    // down to the sleep, worded as the relay path words it, and a scheduled one
    // is tried again (DOR-3286).
    terminal = withSleepBlame(terminal, input.stop.justWoke());
    terminal.sessionId =
      input.agentManager.getInternalSessionId(input.sessionId) ?? input.sessionId;
    input.store.updateRun(input.run.id, terminal);
    if (input.emitCancellation && terminal.status === 'cancelled') {
      emitRunActivity(
        input.activityService,
        input.task,
        input.run,
        'cancelled',
        Date.now() - input.startTime
      );
    }
  }
}
