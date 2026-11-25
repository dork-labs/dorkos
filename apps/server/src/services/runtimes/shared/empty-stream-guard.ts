/**
 * The empty-stream guard: the single place that decides whether a turn produced
 * anything a person can see, and the error surfaced when it did not.
 *
 * Every runtime is held to it once, at the registry's registration seam
 * (`core/runtime-seam/report-empty-turns.ts`, DOR-3606): a Codex, OpenCode or
 * Doe turn that ends with nothing to show says so, in the same words Claude
 * Code always used.
 *
 * Claude Code also asks it from inside its two dispatch paths —
 * `executeSdkQuery`'s loop (`claude-code/messaging/message-sender.ts`) on the
 * resume-per-message path, and `streamTurnWindow`
 * (`claude-code/sessions/pump-turn-stream.ts`) on the persistent pump — because
 * the answer feeds latches only it holds (the tool turn's retirement reason, the
 * interrupted settle). Its error is a reported failure to the seam, so the seam
 * never adds a second one. They used to answer from two hand-kept copies of the
 * same literal set, and a turn that the pump forgives and the sender calls a
 * crash is a bug an operator meets at random. One module, one answer.
 *
 * @module services/runtimes/shared/empty-stream-guard
 */
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';
import { isBlockingInteractionEventType } from '@dorkos/shared/session-stream';
import type {
  CompactBoundaryEvent,
  ErrorCategory,
  OperationProgressEvent,
  StreamEvent,
} from '@dorkos/shared/types';

/**
 * Event types that are, on their own, proof the turn said or did something —
 * the agent's words, its thinking, a tool it called, a result it got back, a
 * picture it produced.
 *
 * `image_attachment` is here because a picture is something a person can see.
 *
 * Be precise about how much work it does: in the ORDINARY turn the tool call
 * that produced the image already emitted `tool_call_start`, which counts, so
 * the guard was never going to fire anyway. What this entry covered was the
 * turn where it did not — a `tool_result` arriving without its own start frame
 * (a re-delivered or replayed result, a window that opened mid-call), where a
 * result carrying ONLY an image mapped to no `tool_result` event either,
 * because there was no text to put in one.
 *
 * That last clause stopped being true in DOR-2011: the terminal `tool_result`
 * is emitted for every result block now, empty text included, so an image-only
 * result carries a counting event of its own. This entry is therefore belt-and-
 * braces today, and it stays exactly as it is. What it protects against is
 * printing "the agent did not respond" over a picture the person can plainly
 * see — the `/compact` defect (DOR-1235) in a new costume — and that claim must
 * not rest on the emission rules of a mapper in another directory, which have
 * now changed twice. A redundant line here costs nothing; the day it is needed
 * again, nothing will announce it.
 */
const CONTENT_EVENT_TYPES = new Set<string>([
  'text_delta',
  'tool_call_start',
  'tool_result',
  'thinking_delta',
  'image_attachment',
]);

/**
 * The typed error surfaced when a turn produced zero content events: the
 * process ran but the agent never said or did anything visible.
 */
export function emptyStreamError(): StreamEvent {
  return {
    type: 'error',
    data: {
      message: 'The agent did not respond. The service may be temporarily unavailable.',
      category: 'execution_error' as ErrorCategory,
    },
  };
}

/**
 * Whether this event is proof the turn produced something for the person who
 * asked.
 *
 * The ordinary members are {@link CONTENT_EVENT_TYPES}. The one that needs
 * explaining is `compact_boundary`:
 *
 * A **manual** boundary is the entire product of a `/compact` turn. The SDK
 * runs compaction and the model then has nothing to say, so the turn closes
 * with no text, no thinking and no tool calls — a fully successful compaction
 * looks bit-for-bit like a dead stream to a guard that only counts assistant
 * output. That is what made a working `/compact` report "Claude Code stopped
 * unexpectedly" while the boundary it had just rendered sat directly above the
 * error card (DOR-1235). The boundary IS the answer, so it counts.
 *
 * An **auto** boundary does not count. There the compaction was incidental —
 * the person asked for something else and context pressure fired mid-turn — so
 * a turn that compacts and then falls silent still owes them an answer, and the
 * guard should still say so.
 *
 * @param event - A mapped stream event, before it leaves the server.
 */
export function isContentEvent(event: StreamEvent): boolean {
  if (CONTENT_EVENT_TYPES.has(event.type)) return true;
  if (event.type === 'compact_boundary') {
    // `StreamEvent.data` is a bare union, not discriminated on `type`, so the
    // member has to be named to read `trigger`. A boundary the SDK sent without
    // metadata validates as `{}` and does not count — absent proof is not proof.
    return (event.data as CompactBoundaryEvent).trigger === 'manual';
  }
  return false;
}

/**
 * Whether this event means the turn is waiting on a person (an approval card, a
 * question prompt, an MCP elicitation) rather than having finished empty.
 *
 * Derived from {@link isBlockingInteractionEventType} — the SAME canonical set
 * the session projector folds into lifecycle `blocked` and the Telegram
 * adapter stops its typing indicator for (`@dorkos/shared/session-stream`) —
 * rather than a second hand-kept list. A local copy here once dropped
 * `elicitation_prompt` (DOR-1240): `interactive-handlers.ts` pushes it onto
 * `session.eventQueue` exactly like the other two, so the two-member literal
 * made an elicitation-only turn (no text, no thinking, no tool call, just a
 * person left holding an unanswered prompt) read as a dead stream on both
 * dispatch paths — the last thing "The agent did not respond" should say.
 *
 * @param event - A mapped stream event, before it leaves the server.
 */
export function isInteractiveEvent(event: StreamEvent): boolean {
  return isBlockingInteractionEventType(event.type);
}

/**
 * Whether this event has ALREADY told the person what went wrong, so the guard
 * must not add its vaguer line on top.
 *
 * A typed `error` is the obvious one. The other is a named operation that
 * resolved `failed`: a compaction that could not run fires
 * `operation_progress{ operation: 'compaction', state: 'failed', error }` and
 * NO boundary (`sdk/event-mappers/system-event-mapper.ts`), which is neither
 * content nor a typed error. Left unrecognised, a turn that had just said
 * exactly why compaction failed also got "The agent did not respond. The
 * service may be temporarily unavailable." — two verdicts on one failure, the
 * second one both vaguer and wrong about the cause. The specific one wins.
 *
 * Deliberately not narrowed to `operation: 'compaction'`: the operation union
 * is documented as extensible, and any named operation that reports its own
 * failure has, by then, reported it.
 *
 * @param event - A mapped stream event, before it leaves the server.
 */
export function isReportedFailure(event: StreamEvent): boolean {
  if (event.type === 'error') return true;
  if (event.type === 'operation_progress') {
    return (event.data as OperationProgressEvent).state === 'failed';
  }
  return false;
}

/**
 * Whether this event shows the person something: {@link isContentEvent}, less a
 * text chunk that is only whitespace.
 *
 * A reply of nothing but spaces and line breaks is an empty reply to the person
 * reading it, so it does not count. Each chunk is judged on its own, which is
 * enough: one chunk with a single visible character anywhere in the turn makes
 * it a reply. Kept apart from {@link isContentEvent} because the relay's and
 * Claude Code's windowing rules mirror that one event type for event type.
 *
 * @param event - A mapped stream event, before it leaves the server.
 */
export function isVisibleContent(event: StreamEvent): boolean {
  if (event.type !== 'text_delta') return isContentEvent(event);
  const text = (event.data as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' && text.trim() !== '';
}

/**
 * Whether this event says the turn was stopped, so its silence is not a fault.
 *
 * A runtime that names an interrupted ending (`interrupted`, `aborted_streaming`,
 * `aborted_tools`) or says a stop was asked for has stopped, unless it says in
 * the same breath that nobody asked: an abort nobody requested is a turn that
 * broke, and still owes the person the error.
 *
 * @param event - A mapped stream event, before it leaves the server.
 */
export function isStopEvent(event: StreamEvent): boolean {
  const data = event.data as { terminalReason?: unknown; stopWasRequested?: unknown } | undefined;
  if (data?.stopWasRequested === true) return true;
  if (data?.stopWasRequested === false) return false;
  return (
    typeof data?.terminalReason === 'string' && isInterruptedTerminalReason(data.terminalReason)
  );
}

/**
 * What the seam yields for an empty turn: {@link emptyStreamError}, then a
 * status naming `error` as the turn's ending.
 *
 * The status is not decoration. A runtime that closes every turn with
 * `terminalReason: 'completed'` (Codex does) would otherwise have that reason
 * absolve the error, and the chat would settle idle under an error card
 * (`@dorkos/shared/run-outcome`). The last reason wins, so this one does.
 *
 * @param sessionId - The session the turn ran in.
 */
export function* emptyTurnFailure(sessionId: string): Generator<StreamEvent> {
  yield emptyStreamError();
  yield { type: 'session_status', data: { sessionId, terminalReason: 'error' } };
}

/** One turn's answer to "did it show the person anything?", folded event by event. */
export interface EmptyTurnWatch {
  /** Fold in one event the turn yielded. */
  observe(event: StreamEvent): void;
  /** Record that somebody asked the turn to stop. */
  noteStop(): void;
  /** Whether the turn, as seen so far, ended with nothing and owes the person the error. */
  isEmpty(): boolean;
}

/**
 * Start watching one turn. It is empty until it shows something
 * ({@link isVisibleContent}), waits on a person ({@link isInteractiveEvent}),
 * reports its own failure ({@link isReportedFailure}) or is stopped
 * ({@link isStopEvent}, or {@link EmptyTurnWatch.noteStop}).
 */
export function watchForEmptyTurn(): EmptyTurnWatch {
  let answered = false;
  return {
    observe(event) {
      answered ||=
        isVisibleContent(event) ||
        isInteractiveEvent(event) ||
        isReportedFailure(event) ||
        isStopEvent(event);
    },
    noteStop() {
      answered = true;
    },
    isEmpty: () => !answered,
  };
}
