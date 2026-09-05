/**
 * Whether a stream event is proof the turn produced something, as opposed to
 * proof it ENDED.
 *
 * ## Why a second copy exists, and what stops it drifting
 *
 * The canonical answer is `isContentEvent` in
 * `apps/server/src/services/runtimes/claude-code/messaging/empty-stream-guard.ts`
 * — the single place that decides whether a claude-code turn said anything a
 * person can see, and the set `message-sender.ts` keeps its own
 * `contentEventCount` against. This package cannot import it: `@dorkos/relay`
 * sits below `apps/server` and the dependency only runs the other way.
 *
 * So this is a deliberate mirror, and **the two must not drift**. What holds
 * them together is not this comment: `apps/server` can see both, and
 * `services/relay/__tests__/relay-content-event-parity.test.ts` walks every
 * member of `StreamEventTypeSchema` and asserts the two predicates give the same
 * answer for each — including both `compact_boundary` triggers. A type added to
 * one set and not the other reds it.
 *
 * ## Why the relay needs the distinction at all
 *
 * A turn that only ERRORED still emits events — claude-code synthesizes a
 * terminal `done` when the model produced none, a pre-stream credential failure
 * arrives as `{ type: 'error' }` rather than a throw, and the empty-stream guard
 * turns a zero-content turn into a yielded error. Counting those as "the turn
 * ran" is how a first turn that only said "not signed in" would bind its
 * conversation to whichever runtime happened to be asked (DOR-1774), and
 * `persistSessionRuntime` is first-write-wins, so that binding would be
 * permanent.
 *
 * @module relay/lib/content-events
 */
import type { CompactBoundaryEvent, StreamEvent } from '@dorkos/shared/types';

/**
 * Event types that are, on their own, proof the turn said or did something.
 *
 * Mirrors `CONTENT_EVENT_TYPES` in the server's empty-stream guard; the parity
 * test named in this module's header is what keeps the two identical.
 */
const CONTENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text_delta',
  'tool_call_start',
  'tool_result',
  'thinking_delta',
  'image_attachment',
]);

/**
 * Whether this event is proof the turn produced something rather than proof it
 * ended.
 *
 * `compact_boundary` counts only when the compaction was asked for: a manual
 * boundary IS the whole product of a `/compact` turn, while an auto boundary
 * fired incidentally mid-turn and leaves the turn still owing an answer. Same
 * rule, same reasoning, as the canonical predicate this mirrors.
 *
 * @param event - An event the runtime yielded.
 */
export function isTurnContentEvent(event: StreamEvent): boolean {
  if (CONTENT_EVENT_TYPES.has(event.type)) return true;
  if (event.type === 'compact_boundary') {
    // `StreamEvent.data` is a bare union, not discriminated on `type`, so the
    // member has to be named to read `trigger`. A boundary sent without
    // metadata validates as `{}` and does not count — absent proof is not proof.
    return (event.data as CompactBoundaryEvent).trigger === 'manual';
  }
  return false;
}
