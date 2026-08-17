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
 *   - `question_prompt` attaches its questions to the tool call that raised it,
 *     and the `interaction_resolved` that retires it attaches how it ended, so
 *     a reopened transcript still shows what was asked and what became of it.
 *   - `compact_boundary` emits a `messageType: 'compaction'` message at its own
 *     seq — the same shape the Claude adapter builds from JSONL, so one row
 *     renders both. It is the only fold that does not require an open turn.
 *   - Message ids are deterministic from the turn's `turn_start` seq (the
 *     boundary's from its own), so a rebuilt snapshot yields stable ids across
 *     reconnects.
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
import {
  approvalOutcomeOf,
  questionOutcomeOf,
  type SessionEvent,
} from '@dorkos/shared/session-stream';
import type { ErrorPart, HistoryMessage, HistoryToolCall, MessagePart } from '@dorkos/shared/types';
import { SDK_TOOL_NAMES } from '@dorkos/shared/constants';

/** The `error` session-event member, the per-turn error accumulator entry. */
type ErrorSessionEvent = Extract<SessionEvent, { type: 'error' }>;

/** The resolved-interaction fields a tool call carries into history. */
type ApprovalReceipt = Pick<
  HistoryToolCall,
  | 'approvalOutcome'
  | 'approvalResolvedAt'
  | 'approvalStartedAt'
  | 'approvalReasonGiven'
  | 'questionOutcome'
>;

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
  /**
   * Answered approvals, by the id of the tool call each one gated. Applied when
   * the turn closes rather than on arrival, so a runtime that reports the
   * answer before the call it gated still annotates the right tool.
   */
  receipts: Map<string, ApprovalReceipt>;
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
 * Apply the turn's answered approvals onto the tool calls they gated.
 *
 * A receipt whose tool call is not in this turn is dropped: history annotates
 * what it holds and invents nothing. (That is the ordinary shape for a runtime
 * whose permission ids live in their own id space — OpenCode answers a
 * `Permission.id`, which is not any tool call's id.)
 */
function applyReceipts(turn: TurnAccumulator): void {
  for (const [toolCallId, receipt] of turn.receipts) {
    const tool = turn.tools.get(toolCallId);
    if (tool) Object.assign(tool, receipt);
  }
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
      // Same reason as the approval receipt below: a part list is what the
      // client renders from when present, so a question that lived only on
      // `toolCalls` would lose both its options and its ending on a failed turn.
      ...(tool.questions !== undefined
        ? {
            interactiveType: 'question' as const,
            questions: tool.questions,
            answers: tool.answers,
            questionOutcome: tool.questionOutcome,
          }
        : {}),
      // A part list is what the client renders from when present, so a receipt
      // that lived only on `toolCalls` would vanish on a failed turn.
      // `interactiveType` is what marks the part as a permission prompt at all.
      ...(tool.approvalOutcome !== undefined
        ? {
            interactiveType: 'approval' as const,
            approvalOutcome: tool.approvalOutcome,
            approvalResolvedAt: tool.approvalResolvedAt,
            approvalStartedAt: tool.approvalStartedAt,
            approvalReasonGiven: tool.approvalReasonGiven,
          }
        : {}),
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
        turn = { seq: event.seq, text: '', tools: new Map(), errors: [], receipts: new Map() };
        if (event.userMessage !== undefined) {
          messages.push({ id: `user-${event.seq}`, role: 'user', content: event.userMessage });
        }
        break;
      case 'turn_input':
        // A steer (`turn_input`) joined this turn — the person spoke again mid-
        // turn (spec `persistent-session-runtime` §P4). For a log-backed runtime
        // this stream IS the transcript, so the steer survives only if it is
        // rebuilt here; a file-backed runtime (claude-code) never uses this
        // loader, and its own transcript already records the steered input. It
        // emits a user message at the point it arrived — inline between the
        // trigger and the assistant reply, the closest this fold expresses to
        // its true position (the fold already concatenates a turn's text, so
        // exact interleaving with the assistant output is not represented).
        messages.push({ id: `steer-${event.messageId}`, role: 'user', content: event.content });
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
        // The terminal status the runtime reported, rather than the optimistic
        // `complete` the entry was created with. A denied or failed tool that
        // came back from history wearing a check is half of DOR-1293.
        entry.status = event.status;
        break;
      }
      case 'question_prompt': {
        // The QUESTION itself, kept. Without it a reopened transcript holds a
        // bare `AskUserQuestion` tool call — the thing a person was asked
        // vanishes, and with it any place to say how it ended (DOR-1293). The
        // ask carries no tool name of its own, so an entry created here is
        // named for the SDK tool that always raises it; a `tool_call` under the
        // same id (which claude-code emits, and test-mode mirrors) has usually
        // named it already, and `toolEntry` keeps the first name it was given.
        if (!turn) break;
        toolEntry(turn, event.id, SDK_TOOL_NAMES.ASK_USER_QUESTION).questions = event.questions;
        break;
      }
      case 'tool_progress': {
        if (!turn) break;
        const entry = turn.tools.get(event.toolCallId);
        if (entry) entry.progressOutput = (entry.progressOutput ?? '') + event.content;
        break;
      }
      case 'compact_boundary': {
        // Pushed HERE, at its own seq, rather than at `turn_end`: its whole job
        // is to mark a position in the transcript.
        //
        // The shape mirrors what the Claude adapter builds from JSONL
        // (transcript-parser.ts: `messageType: 'compaction'` + `compactMetadata`)
        // so one row renders both. Content is empty because this stream carries
        // no summary text — Claude's summary lives in the record the boundary
        // annotates, and a log-backed runtime has no equivalent. Fields are
        // copied one at a time on `!== undefined`, not truthiness, so a
        // measured zero survives.
        //
        // NOT guarded on an open turn, unlike every fold above it — but be
        // precise about what that buys, because the durable store makes the
        // unguarded case narrower than it looks. `SessionEventStore.appendTurn`
        // flushes only turn events, so a boundary INSIDE a turn (every path
        // that exists today: `/compact` wraps one, and OpenCode's mid-turn
        // boundary rides the turn it fires in) is persisted and survives a
        // restart, while a boundary arriving OUTSIDE any turn is given a seq
        // and never written. So the unguarded arm serves exactly one topology:
        // the no-store fallback in `readLogBackedHistory` — the live
        // projector's in-memory log, i.e. unit tests and embedded hosts with no
        // Db. It stays unguarded because dropping it there too would trade a
        // reader's only explanation for the history above it against nothing,
        // not because a durable out-of-turn boundary is a case we serve.
        //
        // ORDERING, unresolved on purpose. A boundary lands at its own seq but
        // this turn's assistant message is only pushed at `turn_end`, so a
        // MID-TURN compaction reconstructs as user → compaction → assistant:
        // the rule is drawn ABOVE text that was written before it. Live, the
        // client folds the boundary into the turn's parts at the position it
        // arrived, so the same compaction reads correctly until the first
        // reload and differently afterwards. This is the general limitation
        // this module's header already names — intra-turn interleaving is not
        // reconstructible without per-part seqs — surfacing on the one event
        // where the position IS the meaning. It bites OpenCode alone (the only
        // runtime that emits a mid-turn boundary), and only on its EventLog
        // fallback, since its history normally comes from the sidecar. Fixing
        // it means giving the assistant message ordered parts rather than
        // special-casing compaction; `reconstructHistoryFromEvents — mixed
        // turn` pins today's shape so that change is a decision and not a
        // surprise.
        const meta = {
          ...(event.trigger !== undefined ? { trigger: event.trigger } : {}),
          ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
          ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        };
        messages.push({
          id: `compaction-${event.seq}`,
          role: 'user',
          content: '',
          messageType: 'compaction',
          ...(Object.keys(meta).length > 0 ? { compactMetadata: meta } : {}),
        });
        break;
      }
      case 'error':
        if (turn) turn.errors.push(event);
        break;
      case 'interaction_resolved': {
        // The permission prompt is a DorkOS event, so its answer has no other
        // home: for a log-backed runtime this stream IS the transcript, and
        // dropping the answer here is what made a receipt die at the next cold
        // open. `approvalOutcomeOf` is the one place the two rules live (an
        // approval, actually answered) — shared with the client's live fold so
        // the reopened line matches the one the person saw.
        if (!turn) break;
        // A question's ending rides the same fold (DOR-1293): for a log-backed
        // runtime this stream is the ONLY transcript, so an expired or
        // dismissed question that was not recorded here came back from a reload
        // looking answered.
        const questionOutcome = questionOutcomeOf(event);
        if (questionOutcome !== undefined) {
          turn.receipts.set(event.id, { questionOutcome });
          break;
        }
        const outcome = approvalOutcomeOf(event);
        if (outcome === undefined) break;
        turn.receipts.set(event.id, {
          approvalOutcome: outcome,
          approvalResolvedAt: event.at,
          approvalStartedAt: event.startedAt,
          approvalReasonGiven: event.reasonGiven,
        });
        break;
      }
      case 'turn_end': {
        if (!turn) break;
        applyReceipts(turn);
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
