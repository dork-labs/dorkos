/**
 * Retire one approval everywhere at once: its card on every surface, and the
 * escalation clock its request started (DOR-1570). The single funnel every
 * ending passes through, whether `ApprovalService` ended the row or the
 * requester withdrew it (`approval-withdrawal.ts`, DOR-4586).
 *
 * @module services/core/approvals/approval-settle
 */
import type { ApprovalOutcome } from '@dorkos/shared/approval-schemas';
import { broadcastApprovalResolved } from './approval-events.js';
import { resolveCapabilityApproval } from '../../notifications/emitters/capability-approval.js';

/**
 * Retire an approval's card and stop its escalation, after its row was ended.
 * Idempotent: a second call for one id changes nothing a person sees.
 *
 * @param approvalId - ULID of the approval that ended.
 * @param outcome - How it ended.
 */
export function settleApproval(approvalId: string, outcome: ApprovalOutcome): void {
  resolveCapabilityApproval(approvalId);
  broadcastApprovalResolved(approvalId, outcome);
}
