import type { Task, UpdateTaskRequest } from '@dorkos/shared/types';
import { runsPrograms } from '@dorkos/shared/permission-rules';
import { isLooserMode } from '../services/tasks/schedule-permission-clamp.js';

/** A refusal returned when approval exceeds the proposal without a person's confirmation. */
export interface TaskApprovalRequestRefusal {
  error: string;
  code: 'looser_than_requested_confirmation_required';
}

/** Separate approval receipt fields from the task patch and enforce its requested ceiling. */
export function prepareTaskApprovalRequest(task: Task, update: UpdateTaskRequest) {
  const {
    approvedPromptHash,
    expectedApprovalRevision,
    approvalSurface,
    acceptLooserThanRequested,
    ...data
  } = update;
  return {
    data,
    approvedPromptHash,
    expectedApprovalRevision,
    approvalSurface,
    refusal: taskApprovalRequestRefusal(task, data, acceptLooserThanRequested),
  };
}

/**
 * Refuse an activation that grants more power than the proposer requested.
 *
 * Outsider-marked work is measured from the unattended safe floor even when it
 * carried no structured request. An applied allow list may be equal to or
 * narrower than the proposal; adding any rule needs the same explicit choice.
 */
export function taskApprovalRequestRefusal(
  task: Task,
  update: UpdateTaskRequest,
  accepted: true | undefined
): TaskApprovalRequestRefusal | null {
  if (task.status !== 'pending_approval' || update.status !== 'active') return null;

  const appliedMode = update.permissionMode ?? task.permissionMode;
  // With no request, the saved (already clamped) mode is the proposal: a looser
  // mode is never set without the confirmation (PM ruling, Security Should D-1).
  const proposedMode = task.requestedPermissionMode ?? task.permissionMode;
  const looserThanRequested = isLooserMode(appliedMode, proposedMode);
  const outsider = task.originMarks?.outsider === true;
  const outsiderAtLooseMode =
    outsider && ['acceptEdits', 'bypassPermissions', 'auto'].includes(appliedMode);
  const requestedRules = new Set(task.requestedAllow ?? []);
  const appliedRules = update.approvedAllow ?? task.approvedAllow ?? [];
  const addsRule = appliedRules.some((rule) => !requestedRules.has(rule));
  // Any rule that starts programs is said plainly and confirmed (D-2), and an
  // outsider's rules get the same extra yes a loose mode gets (D-3).
  const startsPrograms = appliedRules.some(runsPrograms);
  const outsiderRules = outsider && appliedRules.length > 0;

  const needsConfirmation =
    looserThanRequested || outsiderAtLooseMode || addsRule || startsPrograms || outsiderRules;
  if (needsConfirmation && accepted !== true) {
    return {
      error: 'Choose to run this task looser than proposed.',
      code: 'looser_than_requested_confirmation_required',
    };
  }
  return null;
}
