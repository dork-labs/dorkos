/**
 * Columns shared by every task approval write (DOR-3641).
 *
 * @module services/tasks/approvals/task-approval-receipt
 */
import type { pulseSchedules } from '@dorkos/db';
import type { TaskApprover, TaskApprovalVia } from '@dorkos/shared/types';
import { TaskApproverSchema, TaskApprovalViaSchema } from '@dorkos/shared/schemas';
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

/**
 * The receipt columns emptied, written wherever the grant is withdrawn: a
 * record must never say a person approved content they never saw (DOR-3641,
 * Security Should C-1).
 */
export const CLEARED_APPROVAL_RECEIPT = {
  approvedAt: null,
  approvedBy: null,
  approvedVia: null,
} as const;

/**
 * The receipt for work the schedule's own trusted agent re-keyed while it
 * stays live: the agent's trust setting approved it, not the person whose
 * earlier yes covered different content.
 */
export function trustedAgentReceiptColumns() {
  return taskApprovalReceiptColumns(
    completeTaskApproval({ approvedBy: { kind: 'policy' }, approvedVia: 'trusted_agent' })
  );
}

/** Receipt columns for a create, with policy/created as the safe default. */
export function createTaskApprovalColumns(input?: TaskApprovalInput | null) {
  return input === null
    ? {}
    : taskApprovalReceiptColumns(
        completeTaskApproval(input ?? { approvedBy: { kind: 'policy' }, approvedVia: 'created' })
      );
}

/** Who counts most in a receipt: a person, then an agent, then a policy. */
const APPROVER_RANK = { person: 3, agent: 2, policy: 1 } as const;

/** How much a receipt says: who approved first, and a known surface only breaks a tie. */
function receiptWeight(receipt: TaskApprovalReceipt): number {
  return APPROVER_RANK[receipt.approvedBy.kind] * 2 + (receipt.approvedVia === 'unknown' ? 0 : 1);
}

/** The receipt a row holds now, or null when any part is missing or unreadable. */
export function standingTaskApproval(
  row: Pick<typeof pulseSchedules.$inferSelect, 'approvedAt' | 'approvedBy' | 'approvedVia'>
): TaskApprovalReceipt | null {
  if (row.approvedAt === null || row.approvedBy === null || row.approvedVia === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.approvedBy);
  } catch {
    return null;
  }
  const approvedBy = TaskApproverSchema.safeParse(parsed);
  const approvedVia = TaskApprovalViaSchema.safeParse(row.approvedVia);
  return approvedBy.success && approvedVia.success
    ? { approvedAt: row.approvedAt, approvedBy: approvedBy.data, approvedVia: approvedVia.data }
    : null;
}

/**
 * The receipt an approval of the row's CURRENT content writes. Approving the
 * same content again keeps the standing receipt unless the new one says more:
 * re-sending `active` on a live task is not a new approval, and must not turn
 * "Dorian, in the Inbox" into "someone, somewhere" (DOR-3641 review, nit 4).
 * New content always takes the new receipt, since nobody approved it before.
 *
 * @param row - The row as it stands, with its standing grant and receipt.
 * @param incoming - The receipt this approval would write.
 * @param contentKey - The key of the content being approved; defaults to the row's own.
 */
export function reapprovalReceipt(
  row: typeof pulseSchedules.$inferSelect,
  incoming: TaskApprovalReceipt,
  contentKey: string = effectiveContentKey(row)
): TaskApprovalReceipt {
  if (row.approvedContentKey === null || row.approvedContentKey !== contentKey) {
    return incoming;
  }
  const standing = standingTaskApproval(row);
  return standing && receiptWeight(standing) >= receiptWeight(incoming) ? standing : incoming;
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

/**
 * The columns a paused row's return writes when it ARMS the row: the grant for
 * what will run, and its receipt. The receipt is the operator's when the write
 * names one, else the policy's; unchanged content keeps a receipt that says
 * more, so a file coming back never erases who approved it.
 *
 * @param row - The paused row as it stands.
 * @param approval - Who the write says approved it, if anyone (the caller parks a `null`).
 * @param work - The row as the write will leave it, for its content key.
 */
export function unpauseApprovalColumns(
  row: typeof pulseSchedules.$inferSelect,
  approval: TaskApprovalInput | null | undefined,
  work: typeof pulseSchedules.$inferSelect
) {
  // What will RUN, a person's own timing included (DOR-2302).
  const key = effectiveContentKey(work);
  const incoming = completeTaskApproval(
    approval ?? { approvedBy: { kind: 'policy' }, approvedVia: 'unknown' }
  );
  return {
    status: 'active' as const,
    approvedContentKey: key,
    previousApprovalKey: null,
    ...taskApprovalReceiptColumns(reapprovalReceipt(row, incoming, key)),
  };
}
