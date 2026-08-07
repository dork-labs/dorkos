/**
 * Inline projection of an agent's held destructive capability approval (DOR-939).
 *
 * When an agent makes a destructive capability call over the in-session `dorkos`
 * MCP server, the call HOLDS awaiting the operator's decision and the server
 * pushes the same `PendingApproval` the dashboard renders onto the session. These
 * folds turn that pair of events into an inline `capability_approval` part and
 * retire it when the hold resolves — so approving it in the transcript resolves
 * the SAME `approvalId` through the capability decision route, and the card
 * disappears exactly as the dashboard card does on `approval_resolved`.
 *
 * @module features/chat/model/stream/capability-approval-fold
 */
import type { MessagePart } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** Find the `capability_approval` part matching `approvalId`, or `undefined`. */
function findCapabilityApprovalPart(
  parts: MessagePart[],
  approvalId: string
): Extract<MessagePart, { type: 'capability_approval' }> | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === 'capability_approval' && part.approval.approvalId === approvalId) return part;
  }
  return undefined;
}

/**
 * Upsert the inline capability-approval card for a `capability_approval_required`
 * event. The card carries the same `PendingApproval` the dashboard renders, so
 * approving it inline resolves the SAME `approvalId` through the capability
 * decision route — never the SDK `approveTool` path.
 */
export function foldCapabilityApproval(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'capability_approval_required' }>
): void {
  const existing = findCapabilityApprovalPart(parts, event.approval.approvalId);
  if (existing) {
    existing.approval = event.approval;
  } else {
    parts.push({ type: 'capability_approval', approval: event.approval });
  }
}

/**
 * End the inline capability-approval card on its `capability_approval_resolved`
 * event.
 *
 * How it ends depends on the outcome (DOR-987), because the two cases are
 * different for the person reading the transcript:
 *
 * - `granted`/`denied`/`expired` — the request is finished, on the dashboard as
 *   much as here, so the card disappears exactly as the dashboard card retires on
 *   `approval_resolved`.
 * - `timeout` — the agent stopped waiting, but the request is still sitting in
 *   the approvals list. Retiring the card silently would delete the only thing on
 *   screen pointing at a decision the person still owes, so the card stays as a
 *   terminal note instead.
 */
export function foldCapabilityApprovalResolved(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'capability_approval_resolved' }>
): void {
  const index = parts.findIndex(
    (part) => part.type === 'capability_approval' && part.approval.approvalId === event.approvalId
  );
  if (index === -1) return;
  if (event.outcome !== 'timeout') {
    parts.splice(index, 1);
    return;
  }
  const part = parts[index] as Extract<MessagePart, { type: 'capability_approval' }>;
  part.outcome = 'timeout';
}
