/**
 * Carries answered-approval records across the turn-end history reconcile.
 *
 * THE SEAM. When a turn settles, `useTurnEndReconcile` replaces the projection
 * with canonical history from the runtime. That history is runtime-owned — for
 * claude-code it is derived from the SDK's JSONL — and a DorkOS permission
 * prompt is not part of it: the ask happened in DorkOS, was answered in DorkOS,
 * and the transcript on disk knows only that a tool ran or did not. So a
 * straight replace drops every receipt the turn just earned, and worse, flips a
 * denied tool's suppressed card back into a red error row for a failure that
 * never happened.
 *
 * This module re-applies what the client already derived onto the matching
 * history parts. It is not a second source of truth: every field it writes came
 * from the same `interaction_resolved` fold that produced the live receipt, and
 * it is applied at exactly one place (the reconcile). Carrying forward from the
 * PREVIOUS history as well as from the settling turn is what makes it stable —
 * a session that reloads history many times keeps every receipt, not just the
 * newest turn's.
 *
 * ## What the server now covers, and what is left here
 *
 * Outcomes are durable now: the server records every answered approval with the
 * turn it gated and overlays them back onto history, so a reopened conversation
 * rebuilds its receipts with no help from this module. Two jobs are still this
 * module's alone:
 *
 * - The window BEFORE the answer is durable. Rows are flushed when a turn ends,
 *   and the reconcile also fires when a turn settles to `blocked` — mid-turn,
 *   with a second request still pending. The answers already given belong on
 *   that reload.
 * - `approvalDisplayName`. The SDK's short noun phrase arrives on the pending
 *   request and is never recorded, so only the client can keep the receipt's
 *   label from changing at the seam.
 *
 * @module features/chat/lib/carry-approval-receipts
 */
import type { HistoryMessage, MessagePart } from '@dorkos/shared/types';

/** The tool-call member of {@link MessagePart}. */
type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

/** Everything a receipt needs that canonical history cannot supply. */
export interface ApprovalReceiptRecord {
  /** How the request was answered. */
  outcome: NonNullable<ToolCallPart['approvalOutcome']>;
  /** Server epoch ms the answer landed. */
  resolvedAt?: number;
  /** Server epoch ms the request was made. */
  startedAt?: number;
  /** The SDK's short noun phrase, carried so the label cannot change at the seam. */
  displayName?: string;
}

/**
 * Index the answered approvals in a part list by tool-call id.
 *
 * @param parts - Any mix of projected turn parts and history parts.
 * @returns Tool-call id → its receipt record.
 */
export function collectApprovalReceipts(parts: MessagePart[]): Map<string, ApprovalReceiptRecord> {
  const receipts = new Map<string, ApprovalReceiptRecord>();
  for (const part of parts) {
    if (part.type !== 'tool_call' || part.approvalOutcome === undefined) continue;
    receipts.set(part.toolCallId, {
      outcome: part.approvalOutcome,
      resolvedAt: part.approvalResolvedAt,
      startedAt: part.approvalStartedAt,
      displayName: part.approvalDisplayName,
    });
  }
  return receipts;
}

/** Whether a part already carries exactly this record (so rewriting it is pointless). */
function alreadyCarries(part: ToolCallPart, record: ApprovalReceiptRecord): boolean {
  return (
    part.interactiveType === 'approval' &&
    part.approvalOutcome === record.outcome &&
    part.approvalResolvedAt === record.resolvedAt &&
    part.approvalStartedAt === record.startedAt
  );
}

/**
 * Re-apply receipt records onto freshly-loaded history.
 *
 * Messages and parts that gain nothing are returned by reference, so the
 * reconcile does not invalidate memoized renders of the rest of the transcript.
 * A history message with no `parts` array is left alone — the runtimes that
 * produce one always emit parts for a turn that ran tools, and inventing a part
 * list here would fight the history mapper rather than help it.
 *
 * @param messages - Canonical history straight from the runtime.
 * @param receipts - Records from {@link collectApprovalReceipts}.
 * @returns History with the answers restored.
 */
export function applyApprovalReceipts(
  messages: HistoryMessage[],
  receipts: Map<string, ApprovalReceiptRecord>
): HistoryMessage[] {
  if (receipts.size === 0) return messages;
  return messages.map((message) => {
    if (!message.parts) return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool_call') return part;
      const record = receipts.get(part.toolCallId);
      if (!record || alreadyCarries(part, record)) return part;
      changed = true;
      return {
        ...part,
        // `interactiveType` is what marks the part as an approval at all; the
        // receipt renderer keys off it, so carrying the outcome without it
        // would restore the data and none of the display.
        interactiveType: 'approval' as const,
        approvalOutcome: record.outcome,
        approvalResolvedAt: record.resolvedAt,
        approvalStartedAt: record.startedAt,
        ...(record.displayName !== undefined ? { approvalDisplayName: record.displayName } : {}),
      };
    });
    return changed ? { ...message, parts } : message;
  });
}
