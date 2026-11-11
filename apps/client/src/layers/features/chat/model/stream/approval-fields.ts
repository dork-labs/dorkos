/**
 * The fields an `approval_required` event puts on its `tool_call` part, so the
 * card reads everything the server said about the ask.
 *
 * @module features/chat/model/stream/approval-fields
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';

/**
 * An approval event's card fields, for `foldApproval` to upsert.
 *
 * @param event - The `approval_required` event.
 */
export function approvalFieldsOf(event: Extract<SessionEvent, { type: 'approval_required' }>) {
  return {
    interactiveType: 'approval' as const,
    input: event.input,
    status: 'pending' as const,
    // The countdown and its draining bar are both gated on `timeoutMs`: the
    // card renders without a deadline anywhere on it when the emission omits
    // one, which is exactly what production did before DOR-810.
    timeoutMs: event.timeoutMs,
    approvalStartedAt: event.startedAt,
    approvalRemainingMs: event.remainingMs,
    approvalTitle: event.title,
    approvalDisplayName: event.displayName,
    approvalDescription: event.description,
    approvalBlockedPath: event.blockedPath,
    approvalDecisionReason: event.decisionReason,
    approvalHasSuggestions: event.hasSuggestions,
    approvalAlwaysAllowScope: event.alwaysAllowScope,
    approvalAlwaysAllowBreadth: event.alwaysAllowBreadth,
  };
}
