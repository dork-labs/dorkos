/**
 * Put the permission decisions back into a runtime's own history.
 *
 * A permission prompt is asked and answered entirely inside DorkOS. The
 * runtime's transcript — SDK JSONL for claude-code — records only that a tool
 * ran or did not; it has no idea a person was ever asked. So a session reopened
 * tomorrow came back with every receipt gone: the one record a person most
 * wants when reviewing what an agent did was the one thing that did not last.
 *
 * This module closes that. The answers ARE durable — the projector records
 * every `interaction_resolved` in its `'record'` persistence mode
 * (`session-state-projector`) — so history assembled from a foreign transcript
 * can be annotated from them, matching by tool-call id.
 *
 * ## Where this belongs, and where it does not
 *
 * At the SESSION-SERVICE level, composed by a runtime's history read. It needs
 * both sources visible at once — the runtime's assembled messages and the
 * DorkOS event record — and the only two places that see both are here and the
 * runtime adapter that calls it. Deliberately NOT inside claude-code's
 * `transcript-reader`, which owns SDK JSONL parsing and nothing else: teaching
 * it about DorkOS interactions would make the JSONL reader depend on the
 * session-event store to answer a question about a file.
 *
 * Composing it in the adapter's `getMessageHistory` (rather than in the route)
 * is what makes it complete: BOTH history consumers pass through there — `GET
 * /api/sessions/:id/messages` and the cold-open snapshot, which loads history
 * through the same method. Applying it at the route alone would have annotated
 * the reload and left the cold open — the whole point — untouched.
 *
 * A log-backed runtime needs none of this: its history is folded from the same
 * event stream, so `event-log-history` reads the answers straight out of it.
 *
 * @module services/session/approval-receipt-overlay
 */
import { approvalOutcomeOf, type SessionEvent } from '@dorkos/shared/session-stream';
import type { HistoryMessage, MessagePart, ToolApprovalOutcome } from '@dorkos/shared/types';
import { getSessionEventStore, peekProjector } from './session-state-projector.js';

/** What a person's answer to one permission prompt leaves behind. */
export interface ApprovalReceipt {
  /** How it was answered. */
  outcome: ToolApprovalOutcome;
  /** Epoch ms the answer landed, when the resolver said. */
  resolvedAt?: number;
  /** Epoch ms the prompt was raised, when the resolver said. */
  startedAt?: number;
}

/**
 * Index a session's answered approvals by the tool call each one gated.
 *
 * Last answer wins: an id can only resolve twice across a restart-and-replay,
 * and the later row is the one that happened.
 *
 * @param events - Recorded session events, in seq order.
 */
export function collectApprovalReceipts(events: SessionEvent[]): Map<string, ApprovalReceipt> {
  const receipts = new Map<string, ApprovalReceipt>();
  for (const event of events) {
    if (event.type !== 'interaction_resolved') continue;
    const outcome = approvalOutcomeOf(event);
    if (outcome === undefined) continue;
    receipts.set(event.id, { outcome, resolvedAt: event.at, startedAt: event.startedAt });
  }
  return receipts;
}

/** Annotate one tool-call part with the answer to the prompt that gated it. */
function annotatePart(part: MessagePart, receipts: Map<string, ApprovalReceipt>): MessagePart {
  if (part.type !== 'tool_call') return part;
  const receipt = receipts.get(part.toolCallId);
  if (receipt === undefined) return part;
  return {
    ...part,
    // `interactiveType` is what marks the part as a permission prompt at all;
    // the receipt renderer keys off it, so carrying the outcome without it
    // would restore the data and none of the display.
    interactiveType: 'approval',
    approvalOutcome: receipt.outcome,
    approvalResolvedAt: receipt.resolvedAt,
    approvalStartedAt: receipt.startedAt,
  };
}

/** Whether any of a message's tool calls, in either shape, has an answer waiting. */
function needsAnnotation(message: HistoryMessage, receipts: Map<string, ApprovalReceipt>): boolean {
  const inToolCalls = message.toolCalls?.some((tc) => receipts.has(tc.toolCallId)) ?? false;
  const inParts =
    message.parts?.some((p) => p.type === 'tool_call' && receipts.has(p.toolCallId)) ?? false;
  return inToolCalls || inParts;
}

/**
 * Re-apply answered approvals onto assembled history.
 *
 * Both shapes of a tool call are annotated: `toolCalls` (what a log-backed
 * runtime and the transcript parser both emit) and `parts` (what the client
 * renders from when present). Annotating one and not the other would show the
 * receipt on some turns and not others.
 *
 * Messages that gain nothing are returned by reference, so a history reload
 * does not invalidate memoized renders of the rest of the transcript.
 *
 * @param messages - History as the runtime assembled it.
 * @param receipts - From {@link collectApprovalReceipts}.
 * @returns History with the answers restored.
 */
export function applyApprovalReceipts(
  messages: HistoryMessage[],
  receipts: Map<string, ApprovalReceipt>
): HistoryMessage[] {
  if (receipts.size === 0) return messages;
  let changedAny = false;
  const annotated = messages.map((message) => {
    if (!needsAnnotation(message, receipts)) return message;
    changedAny = true;
    return {
      ...message,
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((tc) => {
              const receipt = receipts.get(tc.toolCallId);
              return receipt === undefined
                ? tc
                : {
                    ...tc,
                    approvalOutcome: receipt.outcome,
                    approvalResolvedAt: receipt.resolvedAt,
                    approvalStartedAt: receipt.startedAt,
                  };
            }),
          }
        : {}),
      ...(message.parts ? { parts: message.parts.map((p) => annotatePart(p, receipts)) } : {}),
    };
  });
  return changedAny ? annotated : messages;
}

/**
 * Overlay a session's recorded permission decisions onto history a runtime
 * assembled from its own transcript.
 *
 * Reads the durable rows first and the live projector's log second, so a turn
 * that has not been flushed yet (or a host running without a database) is still
 * annotated, and the live answer wins if both hold one. A session with no
 * recorded answers — an old one, a pruned log, a conversation nobody was ever
 * asked about — comes back exactly as it went in. Never throws: an unreadable
 * record costs the annotations, never the history.
 *
 * @param sessionId - The id the answers were recorded under (canonical, i.e.
 *   the same internal id the history read used).
 * @param messages - History as the runtime assembled it.
 */
export function overlayApprovalReceipts(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  const durable = getSessionEventStore()?.readAll(sessionId) ?? [];
  const live = peekProjector(sessionId)?.replayFrom(0) ?? [];
  if (durable.length === 0 && live.length === 0) return messages;
  return applyApprovalReceipts(messages, collectApprovalReceipts([...durable, ...live]));
}
