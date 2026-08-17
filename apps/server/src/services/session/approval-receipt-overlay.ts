/**
 * Put the interaction decisions back into a runtime's own history.
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
 * Questions ride the same overlay for a related but distinct reason. Their
 * ending IS in the JSONL — as model-facing prose in the tool result, which the
 * transcript parser classifies (`sessions/tool-result-outcome.ts`) — so unlike
 * approvals they are never lost. What DorkOS holds is the same fact stated
 * exactly rather than read out of a sentence, so it is applied on top and wins.
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
import {
  approvalOutcomeOf,
  questionOutcomeOf,
  type SessionEvent,
} from '@dorkos/shared/session-stream';
import type {
  HistoryMessage,
  MessagePart,
  QuestionOutcome,
  ToolApprovalOutcome,
} from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';
import { getSessionEventStore, peekProjector } from './session-state-projector.js';

/** What a person's answer to one interaction leaves behind. */
export interface ApprovalReceipt {
  /** How a permission prompt was answered, when this was one. */
  outcome?: ToolApprovalOutcome;
  /**
   * How a question ended, when this was one. Mutually exclusive with `outcome`
   * — `approvalOutcomeOf` and `questionOutcomeOf` each insist the server said
   * which kind it had, and no interaction is both.
   */
  questionOutcome?: QuestionOutcome;
  /** Epoch ms the answer landed, when the resolver said. */
  resolvedAt?: number;
  /** Epoch ms the prompt was raised, when the resolver said. */
  startedAt?: number;
  /**
   * Whether the person's own words were delivered to the agent with a denial —
   * the durable half of the receipt's "agent was told why" clause.
   */
  reasonGiven?: boolean;
}

/**
 * Index a session's resolved interactions by the tool call each one belongs to.
 *
 * Both kinds that leave a mark are collected. An approval's is the receipt line
 * it earned; a question's is the difference between "you picked Quicksort" and
 * "nobody answered in time" (DOR-1293) — and for claude-code the question half
 * is the AUTHORITATIVE version of something the transcript parser can only
 * infer from the model-facing prose in the tool result.
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
    const questionOutcome = questionOutcomeOf(event);
    if (outcome === undefined && questionOutcome === undefined) continue;
    receipts.set(event.id, {
      ...(outcome !== undefined ? { outcome } : {}),
      ...(questionOutcome !== undefined ? { questionOutcome } : {}),
      resolvedAt: event.at,
      startedAt: event.startedAt,
      reasonGiven: event.reasonGiven,
    });
  }
  return receipts;
}

/** The fields one receipt writes onto the tool call it belongs to. */
function receiptFields(
  receipt: ApprovalReceipt
): Partial<Extract<MessagePart, { type: 'tool_call' }>> {
  if (receipt.questionOutcome !== undefined) {
    return { questionOutcome: receipt.questionOutcome };
  }
  return {
    // `interactiveType` is what marks the part as a permission prompt at all;
    // the receipt renderer keys off it, so carrying the outcome without it
    // would restore the data and none of the display. A question needs no such
    // mark — its own `questions` array already carries it.
    interactiveType: 'approval',
    approvalOutcome: receipt.outcome,
    approvalResolvedAt: receipt.resolvedAt,
    approvalStartedAt: receipt.startedAt,
    approvalReasonGiven: receipt.reasonGiven,
  };
}

/** Annotate one tool-call part with the answer to the interaction it carried. */
function annotatePart(part: MessagePart, receipts: Map<string, ApprovalReceipt>): MessagePart {
  if (part.type !== 'tool_call') return part;
  const receipt = receipts.get(part.toolCallId);
  if (receipt === undefined) return part;
  return { ...part, ...receiptFields(receipt) };
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
              if (receipt === undefined) return tc;
              if (receipt.questionOutcome !== undefined) {
                return { ...tc, questionOutcome: receipt.questionOutcome };
              }
              return {
                ...tc,
                approvalOutcome: receipt.outcome,
                approvalResolvedAt: receipt.resolvedAt,
                approvalStartedAt: receipt.startedAt,
                approvalReasonGiven: receipt.reasonGiven,
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
 * Read a session's recorded resolutions, durable rows first and the open turn
 * second so the live answer wins where both hold one.
 *
 * Both reads are NARROW on purpose, because this runs on every history read —
 * once per turn-end reload, for the whole transcript's life. The store filters
 * to resolution rows in SQL rather than materializing and JSON-parsing every
 * row of a 5,000-row session, and the live half asks only for the OPEN turn
 * (the unflushed window this exists to cover) rather than replaying the whole
 * event log through its merge-and-sort.
 */
function readRecordedResolutions(sessionId: string): SessionEvent[] {
  const durable = getSessionEventStore()?.readInteractionResolutions(sessionId) ?? [];
  const openTurn = peekProjector(sessionId)?.peekInProgressTurn() ?? [];
  if (openTurn.length === 0) return durable;
  return [...durable, ...openTurn];
}

/**
 * Overlay a session's recorded permission decisions onto history a runtime
 * assembled from its own transcript.
 *
 * A session with no recorded answers — an old one, a pruned log, a conversation
 * nobody was ever asked about — comes back exactly as it went in.
 *
 * **Never throws, and that is a contract rather than a courtesy.** This sits on
 * a path that was a pure JSONL read before it existed, feeding BOTH `GET
 * /api/sessions/:id/messages` and the cold-open snapshot, and
 * `AgentRuntime.getMessageHistory` promises an array. The store is SQLite on a
 * machine that routinely runs several agents at once, so `SQLITE_BUSY` is an
 * ordinary event and not a disaster — but a disaster is exactly what it would
 * become if a locked database could empty a person's conversation. A failed
 * read costs the annotations and nothing else.
 *
 * @param sessionId - The id the answers were recorded under (canonical, i.e.
 *   the same internal id the history read used).
 * @param messages - History as the runtime assembled it.
 */
export function overlayApprovalReceipts(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  let recorded: SessionEvent[];
  try {
    recorded = readRecordedResolutions(sessionId);
  } catch (err) {
    logger.warn('[approval-receipts] could not read recorded decisions — history unannotated', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return messages;
  }
  if (recorded.length === 0) return messages;
  return applyApprovalReceipts(messages, collectApprovalReceipts(recorded));
}
