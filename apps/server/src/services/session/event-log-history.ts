/**
 * Reconstruct completed-turn {@link HistoryMessage}s from a session's EventLog
 * stream — the history loader for LOG-BACKED runtimes (ADR-0263 "own the
 * boundary, not the bytes"): a stateless adapter has no native transcript, so
 * the DorkOS-owned event stream is its only persistence. The Claude adapter
 * never uses this (its history comes from JSONL).
 *
 * Folding rules:
 *   - `turn_start.userMessage` (the DorkOS trigger content, ADR-0264) emits a
 *     user message — including for the still-open turn, matching the Claude
 *     adapter where the user message is on disk the moment the turn starts.
 *   - Assistant output (`text_delta` accumulation, `tool_call`/`tool_result`
 *     merged by toolCallId, `tool_progress` appended) emits one assistant
 *     message per turn, only once the turn closes with `turn_end` — the open
 *     turn's events are delivered separately as `inProgressTurn`.
 *   - Message ids are deterministic from the turn's `turn_start` seq, so a
 *     rebuilt snapshot yields stable ids across reconnects.
 *
 * Deliberate simplifications vs Claude's JSONL history: no `parts` array (all
 * turn text concatenates ahead of the tool list, so text/tool interleaving
 * order is lost), `thinking_delta` is dropped, and `progressOutput` is kept
 * alongside the terminal `result`. Sufficient for the contract proof; a real
 * log-backed runtime wanting full render fidelity would extend the fold. The
 * reconstructable depth is bounded by `EVENT_LOG_MAX_EVENTS` — turns trimmed
 * from the log fall out of history by design (that IS the retention policy of
 * a log-backed runtime).
 *
 * @module services/session/event-log-history
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { HistoryMessage, HistoryToolCall } from '@dorkos/shared/types';

/** Accumulator for one turn while folding the event stream. */
interface TurnAccumulator {
  /** The turn's `turn_start` seq — the deterministic id base. */
  seq: number;
  /** Concatenated assistant text deltas. */
  text: string;
  /** Tool calls merged by toolCallId, in first-seen order. */
  tools: Map<string, HistoryToolCall>;
}

/** Get-or-create the merged tool entry for a toolCallId. */
function toolEntry(turn: TurnAccumulator, toolCallId: string, toolName: string): HistoryToolCall {
  let entry = turn.tools.get(toolCallId);
  if (!entry) {
    entry = { toolCallId, toolName, status: 'complete' };
    turn.tools.set(toolCallId, entry);
  }
  return entry;
}

/**
 * Fold a session's ordered {@link SessionEvent}s into completed-turn
 * {@link HistoryMessage}s. Pure and synchronous; tolerant of a trimmed log
 * (events before the first retained `turn_start` are unattributable and
 * skipped).
 *
 * @param events - The session's retained events in seq order (e.g.
 *   `projector.replayFrom(0)`).
 */
export function reconstructHistoryFromEvents(events: SessionEvent[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  let turn: TurnAccumulator | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'turn_start':
        turn = { seq: event.seq, text: '', tools: new Map() };
        if (event.userMessage !== undefined) {
          messages.push({ id: `user-${event.seq}`, role: 'user', content: event.userMessage });
        }
        break;
      case 'text_delta':
        if (turn) turn.text += event.text;
        break;
      case 'tool_call': {
        if (!turn) break;
        const entry = toolEntry(turn, event.toolCallId, event.toolName);
        if (event.input !== undefined) entry.input = event.input;
        break;
      }
      case 'tool_result': {
        if (!turn) break;
        const entry = toolEntry(turn, event.toolCallId, event.toolName);
        if (event.input !== undefined) entry.input = event.input;
        if (event.result !== undefined) entry.result = event.result;
        break;
      }
      case 'tool_progress': {
        if (!turn) break;
        const entry = turn.tools.get(event.toolCallId);
        if (entry) entry.progressOutput = (entry.progressOutput ?? '') + event.content;
        break;
      }
      case 'turn_end': {
        if (!turn) break;
        if (turn.text.length > 0 || turn.tools.size > 0) {
          messages.push({
            id: `assistant-${turn.seq}`,
            role: 'assistant',
            content: turn.text,
            ...(turn.tools.size > 0 ? { toolCalls: [...turn.tools.values()] } : {}),
          });
        }
        turn = null;
        break;
      }
      default:
        break;
    }
  }

  return messages;
}
