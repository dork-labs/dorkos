/**
 * The mode "Try it once now" runs a schedule at while it waits for approval
 * (review of DOR-3637). A trial is not an approval, so it never runs looser
 * than what one click could approve: the tightest of the saved mode, the
 * requested mode and, for outsider-written work, the outsider floor.
 *
 * @module routes/task-trial-mode
 */
import type { PermissionMode, Task } from '@dorkos/shared/types';
import { isLooserScheduleMode, scheduleApprovalBaseline } from '@dorkos/shared/schedule-approval';
import type { MeshCore } from '@dorkos/mesh';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { resolveTaskRunRuntime } from '../services/tasks/execution/run-runtime.js';

/** Refused when a trial cannot be held to the baseline. */
export const TRIAL_TOO_LOOSE_REFUSAL = {
  error: 'This test run would be looser than the proposal. Approve it first.',
  code: 'trial_looser_than_proposal',
} as const;

/** What the trigger route does with a schedule a person wants to try once. */
export type TrialMode =
  { kind: 'saved' } | { kind: 'tightened'; permissionMode: PermissionMode } | { kind: 'refused' };

/**
 * Decide the trial's mode. Only a pending schedule is held to the baseline; an
 * approved one runs at the mode a person already approved. When the baseline
 * is a mode the runtime the run starts on (the task's, else its agent's, else
 * the default) does not declare, the trial is refused rather than run looser.
 *
 * @param task - The schedule, or undefined when it does not exist.
 * @param meshCore - Finds the task's agent folder, for its runtime.
 */
export async function pendingTrialMode(
  task: Task | undefined | null,
  meshCore?: Pick<MeshCore, 'getProjectPath'>
): Promise<TrialMode> {
  if (!task || task.status !== 'pending_approval') return { kind: 'saved' };
  const baseline = scheduleApprovalBaseline(task);
  if (!isLooserScheduleMode(task.permissionMode, baseline)) return { kind: 'saved' };
  const agentPath = task.agentId ? meshCore?.getProjectPath(task.agentId) : null;
  const runtime = await resolveTaskRunRuntime(task, runtimeRegistry, agentPath);
  const declared = runtimeRegistry.getAllCapabilities()[runtime]?.permissionModes?.values ?? [];
  return declared.some((mode) => mode.id === baseline)
    ? { kind: 'tightened', permissionMode: baseline as PermissionMode }
    : { kind: 'refused' };
}
