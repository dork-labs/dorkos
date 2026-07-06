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
 * Deliberate simplifications vs Claude's JSONL history: a clean turn carries no
 * `parts` array (all turn text concatenates ahead of the tool list, so
 * text/tool interleaving order is lost), `thinking_delta` is dropped, and
 * `progressOutput` is kept alongside the terminal `result`. A FAILED turn (one
 * that carried `error` events) does emit `parts` so the failure reconstructs
 * inline, matching what Claude's JSONL history provides. Sufficient for the
 * contract proof; a real log-backed runtime wanting full render fidelity would
 * extend the fold. The reconstructable depth is bounded by
 * `EVENT_LOG_MAX_EVENTS` — turns trimmed from the log fall out of history by
 * design (that IS the retention policy of a log-backed runtime).
 *
 * @module services/session/event-log-history
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { ErrorPart, HistoryMessage, HistoryToolCall, MessagePart } from '@dorkos/shared/types';

/** The `error` session-event member, the per-turn error accumulator entry. */
type ErrorSessionEvent = Extract<SessionEvent, { type: 'error' }>;

/** Accumulator for one turn while folding the event stream. */
interface TurnAccumulator {
  /** The turn's `turn_start` seq — the deterministic id base. */
  seq: number;
  /** Concatenated assistant text deltas. */
  text: string;
  /** Tool calls merged by toolCallId, in first-seen order. */
  tools: Map<string, HistoryToolCall>;
  /** Typed turn errors, in arrival order. */
  errors: ErrorSessionEvent[];
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
 * Map an accumulated `error` event to an {@link ErrorPart}. `ErrorPart` carries
 * no `code` field, so a code is folded into the details string (prefixed
 * `[code]`) rather than dropped.
 */
function toErrorPart(error: ErrorSessionEvent): ErrorPart {
  const details =
    error.code !== undefined
      ? error.details !== undefined
        ? `[${error.code}] ${error.details}`
        : `[${error.code}]`
      : error.details;
  return {
    type: 'error',
    message: error.message,
    ...(error.category !== undefined ? { category: error.category } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

/**
 * Build the `parts` array for a FAILED turn: the concatenated text (when
 * non-empty), one `tool_call` part per merged tool, then one `error` part per
 * accumulated error. Clean turns never call this — they stay `parts`-less so
 * their reconstruction is byte-identical to the pre-error fold (the client's
 * `mapHistoryMessage` uses `parts` exclusively when present).
 */
function buildFailedTurnParts(turn: TurnAccumulator): MessagePart[] {
  const parts: MessagePart[] = [];
  if (turn.text.length > 0) parts.push({ type: 'text', text: turn.text });
  for (const tool of turn.tools.values()) {
    parts.push({
      type: 'tool_call',
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      status: tool.status,
      ...(tool.input !== undefined ? { input: tool.input } : {}),
      ...(tool.result !== undefined ? { result: tool.result } : {}),
      ...(tool.progressOutput !== undefined ? { progressOutput: tool.progressOutput } : {}),
    });
  }
  for (const error of turn.errors) parts.push(toErrorPart(error));
  return parts;
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
        turn = { seq: event.seq, text: '', tools: new Map(), errors: [] };
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
      case 'error':
        if (turn) turn.errors.push(event);
        break;
      case 'turn_end': {
        if (!turn) break;
        // An errors-only turn still emits an assistant message: the failure IS
        // the turn's output, and dropping it would make a failed turn vanish
        // from a log-backed runtime's history.
        if (turn.text.length > 0 || turn.tools.size > 0 || turn.errors.length > 0) {
          messages.push({
            id: `assistant-${turn.seq}`,
            role: 'assistant',
            content: turn.text,
            ...(turn.tools.size > 0 ? { toolCalls: [...turn.tools.values()] } : {}),
            ...(turn.errors.length > 0 ? { parts: buildFailedTurnParts(turn) } : {}),
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
