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
 * **`approval_pending` is addressed** (DOR-1383, closing the asymmetry the
 * notification-system research flagged as item 11). It carries a capability id,
 * a plain sentence describing what would run, and which agent asked — the same
 * class of detail that made the Ask events addressed in ADR 260819-022912, and
 * an agent principal has no business reading it about itself or anybody else.
 * Carrying no token material was never the same question as being safe to send
 * to every connection.
 *
 * The two events beside it stay unaddressed, deliberately.
 * `approval_resolved` carries an id and an outcome, which is a card retiring and
 * nothing more; `approval_grant_changed` says only THAT the permission list
 * moved. Neither describes what an agent is doing, so addressing them would cost
 * a predicate to withhold nothing.
 *
 * @module services/core/approvals/approval-events
 */
import type { ApprovalOutcome, PendingApproval } from '@dorkos/shared/approval-schemas';
import { eventFanOut } from '../event-fan-out.js';
import { operatorAudience } from '../../notifications/notification-entitlement.js';

/**
 * Broadcast that a new approval is waiting on a person, to the connections
 * entitled to see what it is about.
 *
 * @param approval - The card, exactly as `GET /api/approvals/pending` returns it.
 */
export function broadcastApprovalPending(approval: PendingApproval): void {
  eventFanOut.broadcast('approval_pending', approval, operatorAudience);
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
