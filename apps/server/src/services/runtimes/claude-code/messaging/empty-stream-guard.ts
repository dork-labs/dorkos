/**
 * The empty-stream guard: the single place that decides whether a claude-code
 * turn produced anything a person can see, and the error surfaced when it did
 * not.
 *
 * Both dispatch paths ask the same question — `executeSdkQuery`'s loop
 * (`message-sender.ts`) on the resume-per-message path, and `streamTurnWindow`
 * (`sessions/pump-turn-stream.ts`) on the persistent pump. They used to answer
 * it from two hand-kept copies of the same literal set, and the copies are
 * exactly what a fix has to change in lockstep: a turn that the pump forgives
 * and the sender calls a crash is a bug an operator meets at random. One
 * module, one answer.
 *
 * @module services/runtimes/claude-code/messaging/empty-stream-guard
 */
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
 * the guard was never going to fire anyway. What this entry covers is the turn
 * where it did not — a `tool_result` arriving without its own start frame
 * (a re-delivered or replayed result, a window that opened mid-call), where a
 * result carrying ONLY an image maps to no `tool_result` event either, because
 * there is no text to put in one. That turn's whole visible product is the
 * picture, and without this line the guard would print "the agent did not
 * respond" underneath it — the `/compact` defect (DOR-1235) in a new costume.
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
