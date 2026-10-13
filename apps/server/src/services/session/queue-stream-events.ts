/**
 * The queue's own events on a session's durable stream: the queue itself, a
 * delivered steer, and a staged-context receipt. Server-authored and ingested
 * straight onto the projector. Split out of `message-dispatcher.ts`, which
 * re-exports {@link emitQueueUpdate} for the routes and services that call it.
 *
 * @module services/session/queue-stream-events
 */
import type { MessageDeliveryOutcome } from '@dorkos/shared/schemas';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { getMessageQueueStore, toQueuedMessage } from './message-queue-store.js';
import { peekProjector } from './session-state-projector.js';
import { projectorFor, queueKeyOf } from './resolution/session-key-registry.js';

/**
 * The `queue_update` member as an emitter builds it — the projector stamps the
 * `seq`. Narrowed out of the union member by member, because a bare
 * `Omit<SessionEvent, 'seq'>` over a union keeps only the keys every member
 * shares and would drop `queue` and `outcome` on the floor.
 */
type RawQueueUpdate = Omit<Extract<SessionEvent, { type: 'queue_update' }>, 'seq'>;

/**
 * The `context_staged` member as an emitter builds it — the projector stamps the
 * `seq`, exactly as it does for {@link RawQueueUpdate}.
 */
type RawContextStaged = Omit<Extract<SessionEvent, { type: 'context_staged' }>, 'seq'>;

/**
 * Announce a session's queue on its durable stream — the one way a queue change
 * reaches the windows watching it (spec `persistent-session-runtime` §3.2).
 *
 * Reads the store and emits the WHOLE queue, never a diff. The queue is small
 * and bounded, and a full replacement makes every ordering and dedup bug
 * unrepresentable: a window that missed an update is corrected by the next one
 * instead of drifting. The event is ingested like any other, so it is stamped
 * with a `seq`, replayed to a client resuming from `Last-Event-ID`, and covered
 * by the client's existing idempotent-apply-by-seq with no new rules.
 *
 * **Call this after every queue mutation** — enqueue, edit, reorder, remove,
 * dispatch, clear. The dispatcher calls it for the two mutations it owns; the
 * queue routes call it for theirs. A mutation that forgets leaves every other
 * window showing a queue that is no longer true until something else changes.
 *
 * A no-op when no queue store is wired (most unit tests) or when
 * no projector is registered for the session: with nobody listening there is
 * nothing to correct, and the next cold connect reads the queue from the store
 * anyway.
 *
 * @param sessionId - Either id a caller might hold (request uuid or canonical)
 * @param outcome - Present when an accepted message caused this update, so the
 *   sender's window can say what actually happened to it
 */
export function emitQueueUpdate(sessionId: string, outcome?: MessageDeliveryOutcome): void {
  const store = getMessageQueueStore();
  if (!store) return;
  const sessionKey = queueKeyOf(sessionId);
  const projector = peekProjector(sessionKey);
  if (!projector) return;
  const event: RawQueueUpdate = {
    type: 'queue_update',
    queue: store.list(sessionKey).map(toQueuedMessage),
    ...(outcome !== undefined ? { outcome } : {}),
  };
  projector.ingest(event);
}

/**
 * The `turn_input` member as an emitter builds it — the projector stamps the
 * `seq`. Narrowed member by member for the same reason {@link RawQueueUpdate}
 * is: a bare `Omit<SessionEvent, 'seq'>` keeps only the union's shared keys.
 */
type RawTurnInput = Omit<Extract<SessionEvent, { type: 'turn_input' }>, 'seq'>;

/**
 * Carry a delivered steer onto a session's durable stream so it renders inline
 * in the running turn (spec `persistent-session-runtime` §P4, task 4.3).
 *
 * A steer JOINS the open turn — {@link deliverSteer} is the one caller, and it
 * calls this ONLY once the runtime confirmed delivery — so the person's words
 * reached the model but produced no turn-shaped events of their own: the
 * transcript would show the agent changing course with nothing to say why. This
 * mints the carrier for it. Server-authored and ingested straight onto the
 * projector, exactly like {@link emitQueueUpdate}: it is not a runtime
 * `StreamEvent`, so it has no `session-event-normalizer` mapping.
 *
 * Ingested (not opening or closing a turn) it rides the OPEN turn — the
 * projector pushes any non-boundary event onto `inProgressTurn` — so it gets a
 * `seq`, replays gap-free to a client resuming from `Last-Event-ID`, and folds
 * inline in reading order. Ordering holds because this runs synchronously the
 * instant delivery returns, before the model's answer to the steer can stream
 * back, and under the dispatch mutex {@link deliverSteer} holds so no `turn_end`
 * can straddle it.
 *
 * A no-op when no projector is registered for the session (nobody is listening,
 * and a delivered steer with no live turn is not a state that reaches here).
 *
 * @param sessionKey - The session's primary key (the id its projector is under).
 * @param content - The person's words, pristine — the same text handed the model.
 * @param messageId - The steer's server-minted correlation id.
 */
export function emitTurnInput(sessionKey: string, content: string, messageId: string): void {
  const projector = projectorFor(sessionKey);
  if (!projector) return;
  const event: RawTurnInput = { type: 'turn_input', content, disposition: 'steer', messageId };
  projector.ingest(event);
}

/**
 * Announce that a person STAGED context — the receipt for a `stage` (spec
 * `persistent-session-runtime` §2.5, task 4.2). A staged message opens no turn,
 * so it mints no `turn_start`; without this event a successful stage would be
 * indistinguishable on the stream from a dropped one, which is the exact failure
 * the receipt exists to prevent.
 *
 * Synthesized server-side and ingested straight into the projector — the same
 * path {@link emitQueueUpdate} takes, so it is stamped with a `seq`, replayed to
 * a client resuming from `Last-Event-ID`, and folded outside the turn transcript
 * (`EVENTS_OUTSIDE_THE_TURN`) rather than as a user turn. Emitted for BOTH the
 * native path (the message reached the runtime's transcript directly) and the
 * fold-into-next fallback (the text is held to ride the next dispatch).
 *
 * A no-op when no projector is registered — nobody is listening, and a cold
 * connect learns the staged text from the runtime's transcript (native) or sees
 * it fold into the next turn (fallback) either way.
 *
 * @param sessionId - Either id a caller might hold (request uuid or canonical)
 * @param content - The person's staged text, pristine
 * @param messageId - The server-minted correlation id for the staged message
 */
export function emitContextStaged(sessionId: string, content: string, messageId: string): void {
  // `queueKeyOf`, exactly as {@link emitQueueUpdate} resolves it — NOT
  // `primaryOf`. The filing id is the id the session was BORN with, which after
  // the canonical-id rename is not what the projector registry is keyed by, so
  // this receipt reached nobody for every renamed session: the lookup missed and
  // the early return read as "no listeners" (DOR-1262 review). `queueKeyOf` is
  // the one resolver that answers "the id the projector is registered under".
  const projector = peekProjector(queueKeyOf(sessionId));
  if (!projector) return;
  const event: RawContextStaged = { type: 'context_staged', content, messageId };
  projector.ingest(event);
}
