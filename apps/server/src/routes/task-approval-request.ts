import type { Task, UpdateTaskRequest } from '@dorkos/shared/types';
import type { MeshCore } from '@dorkos/mesh';
import { needsOwnConfirmation } from '@dorkos/shared/permission-rules';
import { isLooserScheduleMode, scheduleApprovalBaseline } from '@dorkos/shared/schedule-approval';
import * as personReview from '../services/tasks/approvals/person-review.js';
import type { TaskStore } from '../services/tasks/task-store.js';
import { taskPermissionRulesRefusal } from '../services/tasks/task-permission-rules.js';

/** A refusal returned when approval exceeds the proposal without a person's confirmation. */
export interface TaskApprovalRequestRefusal {
  error: string;
  code: 'looser_than_requested_confirmation_required';
}

/** A PATCH refusal and the status it answers with. */
export interface TaskPatchRefusal {
  status: 400 | 409;
  body: { error: string; code: string };
}

/**
 * Separate approval receipt fields from the task patch, then refuse, in order:
 * rules the task's runs cannot honour (400), a review the proposal has moved
 * past (409, so the card refreshes before anything else is judged), and an
 * approval looser than one click may give (409).
 *
 * @param store - Reads the task again for the stale check.
 * @param task - The task as it stands.
 * @param update - The parsed PATCH body.
 * @param meshCore - Finds the task's agent folder, so the rules are judged
 *   against the runtime its runs actually start on.
 */
export async function prepareTaskApprovalRequest(
  store: Pick<TaskStore, 'getTask'>,
  task: Task,
  update: UpdateTaskRequest,
  meshCore?: Pick<MeshCore, 'getProjectPath'>
) {
  const {
    approvedPromptHash,
    expectedApprovalRevision,
    approvalSurface,
    acceptLooserThanRequested,
    ...data
  } = update;
  const review = personReview.preparePersonTaskReview(store, task, data, expectedApprovalRevision);
  const rules =
    data.requestedAllow !== undefined ||
    data.approvedAllow !== undefined ||
    data.runtime !== undefined
      ? await taskPermissionRulesRefusal({
          runtime: data.runtime !== undefined ? data.runtime : task.runtime,
          agentPath: task.agentId ? meshCore?.getProjectPath(task.agentId) : null,
          rules: [
            ...((data.requestedAllow !== undefined ? data.requestedAllow : task.requestedAllow) ??
              []),
            ...(data.approvedAllow ?? []),
          ],
        })
      : null;
  const looser = taskApprovalRequestRefusal(task, data, acceptLooserThanRequested);
  const refusal: TaskPatchRefusal | null = rules
    ? { status: 400, body: rules }
    : review.stale
      ? { status: 409, body: { ...personReview.STALE_SCHEDULE_REVIEW } }
      : looser
        ? { status: 409, body: looser }
        : null;
  return { data, approvedPromptHash, expectedApprovalRevision, approvalSurface, review, refusal };
}

/**
 * Refuse an activation that grants more power than one click may give.
 *
 * The mode is measured against {@link scheduleApprovalBaseline}: the tightest of
 * the saved mode, the requested mode and, for outsider-marked work, the
 * outsider floor. So a request never widens what one click grants, even one for
 * Full access. An applied allow list may be equal to or narrower than the
 * proposal; adding any rule needs the same explicit choice.
 */
export function taskApprovalRequestRefusal(
  task: Task,
  update: UpdateTaskRequest,
  accepted: true | undefined
): TaskApprovalRequestRefusal | null {
  if (task.status !== 'pending_approval' || update.status !== 'active') return null;

  const appliedMode = update.permissionMode ?? task.permissionMode;
  // The card's tick reads the same baseline (Security Should D-1, review of #3794).
  const looserThanBaseline = isLooserScheduleMode(appliedMode, scheduleApprovalBaseline(task));
  const outsider = task.originMarks?.outsider === true;
  const requestedRules = new Set(task.requestedAllow ?? []);
  const appliedRules = update.approvedAllow ?? task.approvedAllow ?? [];
  const addsRule = appliedRules.some((rule) => !requestedRules.has(rule));
  // A rule that starts programs, writes outside the task's folder or reads
  // broadly (a pattern over an absolute or home path, or a `..` step) is said
  // plainly and confirmed (D-2), and an outsider's rules get the same extra yes
  // a loose mode gets (D-3).
  const ownConfirmation = appliedRules.some(needsOwnConfirmation);
  const outsiderRules = outsider && appliedRules.length > 0;

  const needsConfirmation = looserThanBaseline || addsRule || ownConfirmation || outsiderRules;
  if (needsConfirmation && accepted !== true) {
    return {
      error: 'Choose to run this task looser than proposed.',
      code: 'looser_than_requested_confirmation_required',
    };
  }
  return null;
}
