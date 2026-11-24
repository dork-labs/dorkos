/** Account checks before either scheduled dispatch path starts a conversation. */
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { ActivityService } from '../../activity/activity-service.js';
import { logger } from '../../../lib/logger.js';
import { isRegisteredClaudeAccount } from '../../runtimes/claude-code/claude-config-dir.js';
import type { RunExecution } from '../execution/resolve-run-execution.js';
import { scheduleAccountRefusal } from '../lifecycle/schedule-account-eligibility.js';
import { emitUnregisteredAccountActivity } from '../run-activity.js';
import type { TaskStore } from '../task-store.js';
import { runAccountDecision, type RunAccountReader } from './run-account-fallback.js';
import { resolveRunSession } from './sticky-session.js';

/** What the scheduler has resolved before checking the account's project rules. */
interface RunAccountContext {
  store: TaskStore;
  task: Task;
  run: TaskRun;
  execution: RunExecution;
  placement: { cwd: string; agentPath?: string };
  activityService: ActivityService | null;
  /** Where the run's account and its alternatives are read; a test hands in its own. */
  readAccounts?: RunAccountReader;
}

/**
 * A resumed conversation keeps its account. A replacement, including an owner
 * change, must pass the account's project rules as every new conversation does.
 * Before that, a run whose account is out of usage or signed out moves to
 * another account with room, said on its run row, or fails plainly when its task
 * is pinned to that account (DOR-5097). Report an unregistered account only when
 * its launch hint would be read.
 *
 * @returns Why the run may not start, or `null`. A move rewrites
 *   `execution.settings.accountHint`, which both dispatch paths launch on.
 */
export async function checkRunAccount({
  store,
  task,
  run,
  execution,
  placement,
  activityService,
  readAccounts,
}: RunAccountContext): Promise<Error | null> {
  if (execution.runtimeType !== 'claude-code') return null;
  const { hasStarted } = resolveRunSession(store, task, {
    runtimeType: execution.runtimeType,
    agentPath: placement.agentPath,
  });
  if (hasStarted) return null;
  const decision = await runAccountDecision(
    {
      accountHint: execution.settings.accountHint,
      agentPath: placement.agentPath,
      cwd: placement.cwd,
    },
    task.accountPinned === true,
    readAccounts
  );
  if (decision.kind === 'pinned') return new Error(decision.message);
  if (decision.kind === 'move') {
    const { move } = decision;
    execution.settings.accountHint = move.to.id;
    store.recordRunAccountMove(run.id, move);
    logger.info(`run ${run.id} starts on ${move.to.id}: ${move.from.id} is ${move.reason}`);
  }
  const account = execution.settings.accountHint;
  if (!account) return null;
  if (isRegisteredClaudeAccount(account) === false) {
    emitUnregisteredAccountActivity(activityService, task, run, account);
  }
  return scheduleAccountRefusal({ account, runtime: 'claude-code', folder: placement.cwd });
}
