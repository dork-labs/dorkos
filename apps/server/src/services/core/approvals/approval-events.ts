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

/** Why the set of live standing permissions is different from a moment ago. */
export type StandingPermissionChange = 'created' | 'revoked' | 'ended-all';

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

/**
 * Broadcast that the set of live standing permissions changed, so every open
 * cockpit re-reads it (spec `agent-approval-settings` §3.6).
 *
 * There is no card to show and nothing to answer here — a permission is opened or
 * ended somewhere else and every other window is simply out of date. So the
 * payload says only THAT something changed, not what the list now is: two windows
 * reading the same list from the server cannot disagree, whereas two windows
 * patching their own copies from an event can.
 *
 * This fires for an ending nobody clicked as well as for one somebody did —
 * turning the master switch off, or turning login off, ends every live permission
 * at once, and a cockpit still showing the old rows would be showing trust that no
 * longer exists.
 *
 * Expiry is the one change that produces no event, exactly as it produces none for
 * a pending approval: nothing runs at the moment a window closes. The surfaces
 * that list permissions retire a row on its own deadline, the same way the
 * approval card does.
 *
 * @param change - Whether one was opened, one was ended, or every one was.
 * @param grantId - ULID of the permission that changed, when it was just one.
 */
export function broadcastStandingPermissionsChanged(
  change: StandingPermissionChange,
  grantId?: string
): void {
  eventFanOut.broadcast('approval_grant_changed', {
    change,
    ...(grantId ? { grantId } : {}),
    changedAt: new Date().toISOString(),
  });
}
