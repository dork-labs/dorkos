/**
 * Say in a reopened Claude Code conversation that DorkOS, not a person, ended
 * a turn the agent went quiet in (DOR-3307).
 *
 * ## The case this exists for
 *
 * The stall guard ends a quiet turn by interrupting the CLI, and the CLI writes
 * that interrupt into its transcript in a person's voice:
 * `[Request interrupted by user]` as a user line, and, over a tool that was
 * still running, "The user doesn't want to proceed with this tool use" as the
 * tool's result. Read back, the conversation showed a person's message saying
 * they interrupted, and a tool card the person had apparently declined. Neither
 * happened.
 *
 * DorkOS records the cutoff durably (the `turn_stalled` error, in
 * `RECORDED_EVENT_TYPES`), so this overlay puts the truth back: the interrupt
 * line becomes the cutoff's own sentence, and the tool it cut short reads as
 * stopped by it, not declined.
 *
 * ## Matching a cutoff to its line
 *
 * The parser gives user lines no timestamp, so a marker is placed between the
 * timestamps of the messages around it. A cutoff belongs to the first marker
 * whose window holds the cutoff's row time, and to no other. A cutoff with no
 * marker (the interrupt failed, or the CLI wrote none) is spliced in by time,
 * so the chat still says what happened. A marker no cutoff matches is a
 * person's Stop and is left exactly as it is.
 *
 * @module services/runtimes/claude-code/history/turn-cutoff-overlay
 */
import type { HistoryMessage, HistoryToolCall, ToolCallPart } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import type { RecordedTurnCutoff } from '../../../session/session-event-store.js';
import { getSessionEventStore } from '../../../session/session-state-projector.js';
import { spliceByCreatedAt } from '../../../session/overlays/splice-by-created-at.js';
import { isCliInterruptText } from '../sessions/tool-result-outcome.js';

/** The history row a cutoff becomes: the same error part the live chat showed. */
function cutoffMessage(cutoff: RecordedTurnCutoff, id?: string): HistoryMessage {
  const { message, category } = cutoff.event;
  return {
    id: id ?? `turn-cutoff-${cutoff.event.seq}`,
    role: 'assistant',
    content: '',
    parts: [
      {
        type: 'error',
        message,
        code: 'turn_stalled',
        ...(category !== undefined ? { category } : {}),
      },
    ],
    timestamp: cutoff.createdAt,
  };
}

/** Whether a history row is the CLI's interrupt line. */
function isInterruptMarker(message: HistoryMessage): boolean {
  return message.role === 'user' && message.content.startsWith('[Request interrupted by user');
}

/**
 * Make a tool the cutoff cut short read as stopped by it. The approval outcome
 * the parser inferred from the CLI's refusal text is dropped with it: nobody
 * declined anything.
 */
function clearCutTool(call: HistoryToolCall | ToolCallPart, text: string): void {
  if (call.status !== 'error' || call.result === undefined || !isCliInterruptText(call.result)) {
    return;
  }
  call.result = text;
  if (call.approvalOutcome !== 'denied') return;
  delete call.approvalOutcome;
  delete call.approvalResolvedAt;
  delete call.approvalStartedAt;
  if ('interactiveType' in call && call.interactiveType === 'approval') {
    delete call.interactiveType;
  }
}

/** Rewrite the tools in the assistant row just before a matched marker. */
function clearCutTools(merged: HistoryMessage[], text: string): void {
  const previous = merged[merged.length - 1];
  if (previous?.role !== 'assistant') return;
  previous.toolCalls = previous.toolCalls?.map((call) => ({ ...call }));
  previous.parts = previous.parts?.map((part) => (part.type === 'tool_call' ? { ...part } : part));
  for (const call of previous.toolCalls ?? []) clearCutTool(call, text);
  for (const part of previous.parts ?? []) if (part.type === 'tool_call') clearCutTool(part, text);
}

/** The first timestamp at or after `from`, or undefined at the end of history. */
function nextTimestamp(messages: HistoryMessage[], from: number): string | undefined {
  for (let i = from; i < messages.length; i += 1) {
    const timestamp = messages[i]!.timestamp;
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

/**
 * Lay recorded cutoffs over a Claude Code history.
 *
 * Returns `messages` BY REFERENCE when there are none, so an ordinary history
 * read does not invalidate memoized renders. Rows it rewrites are copied first;
 * the parser's output is never mutated.
 *
 * @param messages - History as the transcript parser assembled it.
 * @param cutoffs - Recorded cutoffs, oldest first.
 */
export function applyTurnCutoffs(
  messages: HistoryMessage[],
  cutoffs: RecordedTurnCutoff[]
): HistoryMessage[] {
  if (cutoffs.length === 0) return messages;
  const unmatched = [...cutoffs];
  const merged: HistoryMessage[] = [];
  let lastSeen = '';
  messages.forEach((message, index) => {
    if (isInterruptMarker(message)) {
      const before = nextTimestamp(messages, index + 1);
      const at = unmatched.findIndex(
        (c) => c.createdAt >= lastSeen && (before === undefined || c.createdAt <= before)
      );
      if (at !== -1) {
        const [cutoff] = unmatched.splice(at, 1);
        if (merged.length > 0) merged[merged.length - 1] = { ...merged[merged.length - 1]! };
        clearCutTools(merged, cutoff!.event.message);
        merged.push(cutoffMessage(cutoff!, message.id));
        return;
      }
    }
    if (message.timestamp !== undefined) lastSeen = message.timestamp;
    merged.push(message);
  });
  return spliceByCreatedAt(merged, unmatched, (cutoff) => cutoffMessage(cutoff));
}

/**
 * Overlay a session's recorded cutoffs onto its Claude Code history.
 *
 * **Never throws**, on the same contract as the other history overlays: this
 * sits on the path that feeds both `GET /api/sessions/:id/messages` and the
 * cold-open snapshot, and a locked database must cost the annotation and
 * nothing else.
 *
 * @param sessionId - The canonical id the cutoffs were recorded under.
 * @param messages - History as the transcript parser assembled it.
 */
export function overlayTurnCutoffs(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  let cutoffs: RecordedTurnCutoff[];
  try {
    cutoffs = getSessionEventStore()?.readTurnCutoffs(sessionId) ?? [];
  } catch (err) {
    logger.warn('[turn-cutoffs] could not read recorded cutoffs — history unannotated', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return messages;
  }
  return applyTurnCutoffs(messages, cutoffs);
}
