/**
 * SSE broadcast helpers for the approval primitive (spec `agent-trust` §3.3).
 *
 * Pending approvals ride the global `/api/events` fan-out so an approval card
 * appears in every open cockpit the moment an agent asks, and disappears from all
 * of them the moment anyone decides. The stream is live-only (no replay), so the
 * cockpit also lists pending approvals on mount — the events are what keep an
 * already-open window in step.
 *
 * Payloads never carry token material: `approval_pending` sends the same record
 * `GET /api/approvals/pending` returns, and nothing more.
 *
 * @module services/core/approvals/approval-events
 */
import type { ApprovalOutcome, PendingApproval } from '@dorkos/shared/approval-schemas';
import { eventFanOut } from '../event-fan-out.js';

/** Broadcast that a new approval is waiting on a person. */
export function broadcastApprovalPending(approval: PendingApproval): void {
  eventFanOut.broadcast('approval_pending', approval);
}

/**
 * Broadcast that a pending approval ended — granted, denied, spent, or expired —
 * so connected cockpits retire its card.
 *
 * @param approvalId - ULID of the approval that ended.
 * @param outcome - How it ended.
 */
export function broadcastApprovalResolved(approvalId: string, outcome: ApprovalOutcome): void {
  eventFanOut.broadcast('approval_resolved', {
    approvalId,
    outcome,
    resolvedAt: new Date().toISOString(),
  });
}
