/**
 * Put a refused tool call back into a runtime's own history.
 *
 * Sibling of `approval-receipt-overlay`, and the mirror image of what it
 * restores: that module puts back the decisions a PERSON made, this one puts
 * back the ones nobody was allowed to make.
 *
 * ## The case this exists for
 *
 * A subagent the agent BACKGROUNDS has nobody to ask. When one of its tool calls
 * needs approval the CLI does not escalate it — it auto-denies and reports the
 * refusal as a `permission_denied` system message on the parent's stream, with
 * the child's `agent_id` attached (`SDKPermissionDeniedMessage`, "headless-agent
 * auto-deny"). The denied call itself is written into the CHILD's transcript,
 * which no reader opens, so the parent conversation came back showing an agent
 * that quietly stopped making progress and no reason anywhere (DOR-795).
 *
 * DorkOS records the denial durably (`RECORDED_EVENT_TYPES`), so the loss is
 * stated exactly once, in the conversation a person actually reads.
 *
 * ## What it does NOT do
 *
 * A denial whose tool call the transcript already contains is left alone. A
 * main-thread classifier or deny-rule refusal has its `tool_use` and its
 * rejection `tool_result` in the JSONL, so that row already tells the story;
 * adding a second row beside it would double-report one event. Only the denials
 * with NO anchor in the transcript — which is exactly the subagent case — become
 * a row of their own.
 *
 * ## Where it belongs
 *
 * At the session-service level, composed by a runtime's history read, for the
 * same reason its sibling is: it needs the runtime's assembled messages and the
 * DorkOS event record visible at once, and only the adapter's
 * `getMessageHistory` sees both. Log-backed runtimes need none of it — their
 * history is folded from this same event stream by `event-log-history`.
 *
 * @module services/session/overlays/permission-denial-overlay
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { HistoryMessage, MessagePart } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { getSessionEventStore, peekProjector } from '../session-state-projector.js';
import type { RecordedPermissionDenial } from '../session-event-store.js';

/** The `permission_denied` session-event member. */
type PermissionDeniedSessionEvent = Extract<SessionEvent, { type: 'permission_denied' }>;

/**
 * The `seq` of every denial the OPEN turn is still carrying live.
 *
 * A denial is written to disk the instant it is ingested, not at `turn_end`
 * (`EAGERLY_RECORDED_EVENT_TYPES`) — because a turn parked on an ask may never
 * reach one, and a refusal in that turn would be lost with it. The cost of that
 * eagerness is a window where one denial exists in BOTH places at once: on the
 * live stream as an `inProgressTurn` event the client is already folding into
 * the streaming bubble, and as a durable row this overlay would splice into
 * history beneath it. Same denial, drawn twice, until the turn ended.
 *
 * So the open turn is read here to SUBTRACT, never to add. `seq` is the right
 * key and the tool-call id is not: one id can legitimately be refused twice
 * across a resume-and-replay, and matching on it would drop a real second
 * denial as though it were the first one echoing.
 */
function openTurnDenialSeqs(sessionId: string): Set<number> {
  const seqs = new Set<number>();
  for (const event of peekProjector(sessionId)?.peekInProgressTurn() ?? []) {
    if (event.type === 'permission_denied') seqs.add(event.seq);
  }
  return seqs;
}

/** Every tool-call id the assembled history already accounts for. */
function toolCallIdsIn(messages: HistoryMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) ids.add(call.toolCallId);
    for (const part of message.parts ?? []) {
      if (part.type === 'tool_call') ids.add(part.toolCallId);
    }
  }
  return ids;
}

/** Build the standalone history row one unanchored denial becomes. */
function denialMessage(denial: RecordedPermissionDenial): HistoryMessage {
  const event: PermissionDeniedSessionEvent = denial.event;
  const part: MessagePart = {
    type: 'permission_denied',
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    message: event.message,
    ...(event.reasonType !== undefined ? { reasonType: event.reasonType } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
  };
  return {
    // Deterministic from the seq, so a reload reconciles onto the same row
    // rather than remounting a new one (the `compaction-${seq}` precedent).
    id: `permission-denied-${event.seq}`,
    role: 'assistant',
    // Empty for the same reason the compaction row's is: the chip IS the
    // content, and prose here would render a second time above it.
    content: '',
    parts: [part],
    timestamp: denial.createdAt,
  };
}

/**
 * Splice unanchored denials into assembled history, in timestamp order.
 *
 * Placement is by the row's wall-clock against each message's own `timestamp`
 * (see {@link RecordedPermissionDenial}): the denial lands after the last
 * message that is not newer than it. A message with no timestamp — the
 * transcript parser omits it for records that carry none — cannot be compared,
 * so it is treated as belonging to the run of messages before it and never
 * displaces a denial on its own.
 *
 * Returns `messages` BY REFERENCE when nothing is spliced, so an ordinary
 * history reload does not invalidate memoized renders of the transcript.
 *
 * @param messages - History as the runtime assembled it.
 * @param denials - Recorded denials, in seq order.
 */
export function applyPermissionDenials(
  messages: HistoryMessage[],
  denials: RecordedPermissionDenial[]
): HistoryMessage[] {
  if (denials.length === 0) return messages;
  const anchored = toolCallIdsIn(messages);
  const unanchored = denials.filter((d) => !anchored.has(d.event.toolCallId));
  if (unanchored.length === 0) return messages;

  const merged: HistoryMessage[] = [];
  let next = 0;
  let lastSeen = '';
  for (const message of messages) {
    // Carry the last timestamp forward across undated messages so a dated
    // denial is not pushed ahead of the run it belongs to.
    if (message.timestamp !== undefined) lastSeen = message.timestamp;
    while (next < unanchored.length && unanchored[next].createdAt <= lastSeen) {
      merged.push(denialMessage(unanchored[next]));
      next += 1;
    }
    merged.push(message);
  }
  // Anything dated after the whole transcript — including every denial in a
  // session whose messages carry no timestamps at all — closes it out.
  for (; next < unanchored.length; next += 1) merged.push(denialMessage(unanchored[next]));
  return merged;
}

/**
 * Overlay a session's recorded tool denials onto history a runtime assembled
 * from its own transcript.
 *
 * A session that was never refused anything comes back exactly as it went in.
 *
 * **Never throws**, on the same contract as `overlayApprovalReceipts` and for
 * the same reason: this sits on the path that feeds BOTH `GET
 * /api/sessions/:id/messages` and the cold-open snapshot, and a locked SQLite
 * database must cost the annotations and nothing else — never a person's
 * conversation.
 *
 * The OPEN turn is read to SUBTRACT ({@link openTurnDenialSeqs}): a denial the
 * live stream is still carrying is already on screen, so its eagerly-written row
 * is skipped until the turn closes and the bubble is rebuilt from history.
 *
 * @param sessionId - The canonical id the denials were recorded under.
 * @param messages - History as the runtime assembled it.
 */
export function overlayPermissionDenials(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  let denials: RecordedPermissionDenial[];
  try {
    const recorded = getSessionEventStore()?.readPermissionDenials(sessionId) ?? [];
    const live = openTurnDenialSeqs(sessionId);
    denials = live.size === 0 ? recorded : recorded.filter((d) => !live.has(d.event.seq));
  } catch (err) {
    logger.warn('[permission-denials] could not read recorded denials — history unannotated', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return messages;
  }
  return applyPermissionDenials(messages, denials);
}
