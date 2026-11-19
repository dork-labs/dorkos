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
import { taskRunRuntime } from '../services/tasks/execution/run-runtime.js';

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
  const runtime = await taskRunRuntime(task, runtimeRegistry, meshCore);
  const declared = runtimeRegistry.getAllCapabilities()[runtime]?.permissionModes?.values ?? [];
  return declared.some((mode) => mode.id === baseline)
    ? { kind: 'tightened', permissionMode: baseline as PermissionMode }
    : { kind: 'refused' };
}

/**
 * Whether a picked mode is strictly stricter than the cap, by a ranking that knows both. An
 * unknown mode reads as loosest in one slot and strictest in the other, so both orders are asked.
 *
 * @param picked - The mode picked on the card.
 * @param capMode - The mode the trial would otherwise run at.
 */
export function pickIsStricter(picked: string, capMode: string): boolean {
  return isLooserScheduleMode(capMode, picked) && !isLooserScheduleMode(picked, capMode);
}

/** Refused when the picked mode is not one the run's runtime offers. */
export const TRIAL_UNKNOWN_MODE_REFUSAL = {
  error: "This task's agent can't run in that mode.",
  code: 'trial_mode_unknown',
} as const;

/**
 * The trial's mode once the person's pick is weighed in (DOR-4336): the pick when it is strictly
 * stricter than the cap {@link pendingTrialMode} sets (the saved mode, or the baseline for a looser
 * one), else the cap. A pick never loosens a run. With no pick, the cap alone decides, as before.
 *
 * @param task - The schedule, or undefined when it does not exist.
 * @param picked - The mode picked on the card, when the request named one.
 * @param meshCore - Finds the task's agent folder, for its runtime.
 */
export async function trialRunMode(
  task: Task | undefined | null,
  picked: string | undefined,
  meshCore?: Pick<MeshCore, 'getProjectPath'>
): Promise<TrialMode | { kind: 'unknown_mode' }> {
  const cap = await pendingTrialMode(task, meshCore);
  if (!task || picked === undefined || cap.kind === 'refused') return cap;
  const runtime = await taskRunRuntime(task, runtimeRegistry, meshCore);
  const declared = runtimeRegistry.getAllCapabilities()[runtime]?.permissionModes?.values ?? [];
  if (!declared.some((mode) => mode.id === picked)) return { kind: 'unknown_mode' };
  const capMode = cap.kind === 'tightened' ? cap.permissionMode : task.permissionMode;
  // Only a pick both sides rank, and strictly stricter, wins. A tie (Ask first beside Don't ask)
  // keeps the cap, and so does a mode the ranking doesn't know, on either side.
  if (!pickIsStricter(picked, capMode)) return cap;
  return { kind: 'tightened', permissionMode: picked as PermissionMode };
}
