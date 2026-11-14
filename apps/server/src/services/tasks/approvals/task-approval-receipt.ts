/**
 * Columns shared by every task approval write (DOR-3641).
 *
 * @module services/tasks/approvals/task-approval-receipt
 */
import type { pulseSchedules } from '@dorkos/db';
import type { TaskApprover, TaskApprovalVia } from '@dorkos/shared/types';
import { effectiveContentKey } from '../timing/effective-timing.js';

/** The actor and path supplied by an approval door. */
export interface TaskApprovalInput {
  /** Who approved the task. */
  approvedBy: TaskApprover;
  /** Where or how the approval happened. */
  approvedVia: TaskApprovalVia;
  /** One timestamp shared with an Activity row; defaults to now. */
  approvedAt?: string;
}

/** A complete approval receipt after its timestamp has been fixed. */
export interface TaskApprovalReceipt {
  /** When approval happened. */
  approvedAt: string;
  /** Who approved the task. */
  approvedBy: TaskApprover;
  /** Where or how approval happened. */
  approvedVia: TaskApprovalVia;
}

/** Fill the timestamp once so the task and Activity receipt can agree exactly. */
export function completeTaskApproval(input?: TaskApprovalInput): TaskApprovalReceipt {
  return {
    approvedAt: input?.approvedAt ?? new Date().toISOString(),
    approvedBy: input?.approvedBy ?? { kind: 'policy' },
    approvedVia: input?.approvedVia ?? 'unknown',
  };
}

/** Build the receipt actor for an approval answered by a card or agent tool. */
export function toolTaskApproval(options: {
  answeredByPerson: boolean;
  agentPath: string | undefined;
  agentName: string | null;
}): TaskApprovalInput {
  return options.answeredByPerson
    ? {
        approvedBy: { kind: 'person', userId: null, name: null },
        approvedVia: 'unknown',
      }
    : {
        approvedBy: {
          kind: 'agent',
          agentPath: options.agentPath ?? 'unknown',
          name: options.agentName,
        },
        approvedVia: 'agent_tool',
      };
}

/** Serialize a receipt into the task row's three audit columns. */
export function taskApprovalReceiptColumns(receipt: TaskApprovalReceipt) {
  return {
    approvedAt: receipt.approvedAt,
    approvedBy: JSON.stringify(receipt.approvedBy),
    approvedVia: receipt.approvedVia,
  };
}

/** Receipt columns for a create, with policy/created as the safe default. */
export function createTaskApprovalColumns(input?: TaskApprovalInput | null) {
  return input === null
    ? {}
    : taskApprovalReceiptColumns(
        completeTaskApproval(input ?? { approvedBy: { kind: 'policy' }, approvedVia: 'created' })
      );
}

/** Choose the receipt for an operator, trusted agent, or parked create. */
export function scheduledTaskCreateApproval(options: {
  parks: boolean;
  trusted: boolean;
  createdBy?: TaskApprover;
}): TaskApprovalInput | null {
  if (options.parks) return null;
  return options.trusted
    ? { approvedBy: options.createdBy ?? { kind: 'policy' }, approvedVia: 'created' }
    : { approvedBy: { kind: 'policy' }, approvedVia: 'trusted_agent' };
}

/** Approval columns for an activation, computed from the row the write will leave. */
export function activationTaskApprovalColumns(
  row: typeof pulseSchedules.$inferSelect,
  updates: Record<string, unknown>,
  approval?: TaskApprovalInput
) {
  return taskApprovalColumns({ ...row, ...updates } as typeof row, completeTaskApproval(approval));
}

/** Every column a person approval writes for the row's current content. */
export function taskApprovalColumns(
  row: typeof pulseSchedules.$inferSelect,
  receipt: TaskApprovalReceipt
) {
  return {
    approvedContentKey: effectiveContentKey(row),
    previousApprovalKey: null,
    followedAgentChanges: null,
    originMarks: null,
    declinedContentKey: null,
    agentApprovalKey: null,
    ...taskApprovalReceiptColumns(receipt),
  };
}
