/** One terminal publication after direct-run identity finalization and unconditional slot release. */
import type { Task, TaskRun } from '@dorkos/shared/types';
import {
  type createRefusedAskLog,
  refusedToolNames,
  withRefusedAsks,
} from '@dorkos/shared/run-refusals';
import { createTaggedLogger } from '../../../lib/logger.js';
import type { TaskStore } from '../task-store.js';
import type { RunAccounting } from '../run-accounting.js';
import type { ActivityService } from '../../activity/activity-service.js';
import { emitRunActivity } from '../run-activity.js';
import type { RunDeadline } from '../timing/wake-settle.js';
import type { RunTurn } from './run-projection.js';

const logger = createTaggedLogger('Tasks');
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
interface FinalizeInput extends Omit<FailureInput, 'error'> {
  task: Task;
  run: TaskRun;
  terminal: Terminal | undefined;
  stop: Pick<RunDeadline, 'cancel'>;
  turn: RunTurn | undefined;
  agentManager: { getInternalSessionId(sessionId: string): string | undefined };
  store: Pick<TaskStore, 'updateRun'>;
  runs: Pick<RunAccounting, 'release'>;
  activityService: ActivityService | null;
  emitCancellation: boolean;
}
/**
 * Release the original operation and publish exactly one result after identity succeeds or refuses.
 * Body failure remains primary; refused identity never resolves or publishes an independent target.
 */
export async function finalizeRunTerminal(input: FinalizeInput): Promise<void> {
  let terminal = input.terminal;
  let identityFailed = false;
  try {
    input.stop.cancel();
    await input.turn?.finish();
  } catch (error) {
    identityFailed = true;
    const primary = terminal?.status === 'failed' ? terminal.error : undefined;
    terminal = {
      ...terminal,
      status: 'failed',
      sessionId: input.sessionId,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - input.startTime,
      error: primary ?? (error instanceof Error ? error.message : String(error)),
      outputSummary:
        terminal?.outputSummary ??
        withRefusedAsks(input.refusals.summaryLine(), input.outputSummary.slice(0, 500)),
      refusedTools: refusedToolNames(input.refusals.all()),
    };
    delete terminal.outcome;
    logger.error(`run ${input.run.id} identity finalization failed:`, error);
  } finally {
    input.runs.release(input.run.id);
  }
  if (terminal) {
    terminal.sessionId = identityFailed
      ? input.sessionId
      : (input.agentManager.getInternalSessionId(input.sessionId) ?? input.sessionId);
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
