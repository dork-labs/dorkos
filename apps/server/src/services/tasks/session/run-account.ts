/** Account checks before either scheduled dispatch path starts a conversation. */
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { ActivityService } from '../../activity/activity-service.js';
import type { AccountNotAllowedError } from '../../core/usage/account-eligibility.js';
import { isRegisteredClaudeAccount } from '../../runtimes/claude-code/claude-config-dir.js';
import type { RunExecution } from '../execution/resolve-run-execution.js';
import { scheduleAccountRefusal } from '../lifecycle/schedule-account-eligibility.js';
import { emitUnregisteredAccountActivity } from '../run-activity.js';
import type { TaskStore } from '../task-store.js';
import { resolveRunSession } from './sticky-session.js';

/** What the scheduler has resolved before checking the account's project rules. */
interface RunAccountContext {
  store: TaskStore;
  task: Task;
  run: TaskRun;
  execution: RunExecution;
  placement: { cwd: string; agentPath?: string };
  activityService: ActivityService | null;
}

/**
 * A resumed conversation keeps its account. A replacement, including an owner
 * change, must pass the account's project rules as every new conversation does.
 * Report an unregistered account only when its launch hint would be read.
 */
export async function checkRunAccount({
  store,
  task,
  run,
  execution,
  placement,
  activityService,
}: RunAccountContext): Promise<AccountNotAllowedError | null> {
  const account = execution.settings.accountHint;
  if (!account || execution.runtimeType !== 'claude-code') return null;
  const { hasStarted } = resolveRunSession(store, task, {
    runtimeType: execution.runtimeType,
    agentPath: placement.agentPath,
  });
  if (hasStarted) return null;
  if (isRegisteredClaudeAccount(account) === false) {
    emitUnregisteredAccountActivity(activityService, task, run, account);
  }
  return scheduleAccountRefusal({ account, runtime: 'claude-code', folder: placement.cwd });
}
