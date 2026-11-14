import type { Task, UpdateTaskRequest } from '@dorkos/shared/types';
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
  const looserThanRequested = task.requestedPermissionMode
    ? isLooserMode(appliedMode, task.requestedPermissionMode)
    : false;
  const outsiderAtLooseMode =
    task.originMarks?.outsider === true &&
    ['acceptEdits', 'bypassPermissions', 'auto'].includes(appliedMode);
  const requestedRules = new Set(task.requestedAllow ?? []);
  const appliedRules = update.approvedAllow ?? task.approvedAllow ?? [];
  const addsRule = appliedRules.some((rule) => !requestedRules.has(rule));

  if ((looserThanRequested || outsiderAtLooseMode || addsRule) && accepted !== true) {
    return {
      error: 'Choose to run this task looser than proposed.',
      code: 'looser_than_requested_confirmation_required',
    };
  }
  return null;
}
