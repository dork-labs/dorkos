/** Person attribution for scheduled task approval receipts. */
import { createHash } from 'node:crypto';
import type { Task, TaskApprovalVia } from '@dorkos/shared/types';
import type { RequestFacts } from '../http/request-facts.js';
import { readOperatorDisplayName } from '../services/core/config/operator-display-name.js';
import type { TaskApprovalInput } from '../services/tasks/approvals/task-approval-receipt.js';

/**
 * Identify the person who approved a task from verified request facts.
 *
 * The saved profile name is the install owner's, so it names the approver only
 * when login is off and the owner is the one person here. A signed-in account
 * is recorded by its id with no name rather than under the owner's.
 */
export function personTaskApprover(caller: Pick<RequestFacts, 'user'>) {
  return {
    kind: 'person' as const,
    userId: caller.user?.userId ?? null,
    name: caller.user ? null : readOperatorDisplayName(),
  };
}

/** Build one timestamped person approval for the task row and Activity. */
export function personTaskApproval(
  caller: Pick<RequestFacts, 'user'>,
  approvedVia: TaskApprovalVia
): TaskApprovalInput {
  return {
    approvedAt: new Date().toISOString(),
    approvedBy: personTaskApprover(caller),
    approvedVia,
  };
}

/** Copy the durable task receipt into an approval Activity event. */
export function taskApprovalActivityMetadata(
  task: Pick<Task, 'approvedAt' | 'approvedBy' | 'approvedVia' | 'permissionMode'>,
  previousPermissionMode: Task['permissionMode'],
  previousReason: string | null,
  personId: string | null
) {
  return {
    approvedAt: task.approvedAt,
    approvedBy: task.approvedBy,
    approvedVia: task.approvedVia,
    permissionMode: task.permissionMode,
    previousPermissionMode,
    reasonHead: createHash('sha256')
      .update(previousReason ?? '')
      .digest('hex'),
    personId,
    raised: task.permissionMode !== previousPermissionMode,
  };
}
