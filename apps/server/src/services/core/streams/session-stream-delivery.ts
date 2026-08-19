/**
 * The durable session stream's sequencing — snapshot → gap-free replay → live —
 * written once for both protocols it is served over.
 *
 * The single delivery path for session state (spec chat-stream-reconnection,
 * Design B.3, ADR-0264/ADR-0266): always on, no feature-flag gate.
 * Runtime-agnostic — it speaks the {@link AgentRuntime} snapshot/subscribe
 * contract, never the projector directly, so it works for any runtime.
 *
 * It knows nothing about HTTP or WebSockets. Both `routes/session-events-handler.ts`
 * (SSE, the public integration contract) and `routes/session-events-socket.ts`
 * (WebSocket, what the cockpit uses) resolve the same plan and hand it here with
 * their own {@link DurableStreamSink}. That is the whole reason this module
 * exists: the cursor arithmetic and the cold-connect race are the parts worth
 * getting right once.
 *
 * @module services/core/streams/session-stream-delivery
 */
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import {
  StaleResumeCursorError,
  isBlockingInteractionEventType,
} from '@dorkos/shared/session-stream';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import type { DurableStreamSink } from './durable-stream-sink.js';
import { STREAM_EPOCH } from '../../../lib/stream-cursor.js';
import type { CallerPrincipal } from '../../../lib/caller-principal.js';
import { askEntitlement } from '../../session/asks/ask-entitlement.js';
import { logger } from '../../../lib/logger.js';

/** Everything a caller must resolve before a session stream can be delivered. */
export interface SessionStreamPlan {
  /** The session being streamed. */
  sessionId: string;
  /** The runtime that owns it. */
  runtime: AgentRuntime;
  /** The boundary-validated cwd plus the effective permission mode. */
  ctx: SessionOpts;
  /** The resume cursor, or `undefined` for a cold connect. */
  sinceCursor: number | undefined;
  /**
   * Who is reading, so an Ask's detail reaches only a caller entitled to it
   * (spec `ask-entitlement`, review finding 2).
   *
   * **Required, never defaulted.** `askEntitlement` says an agent gets `none` —
   * "the Ask does not exist for this caller" — and the fleet-wide list and the
   * global stream both enforce that. This stream is the third door onto the
   * same detail, and one that defaulted to the operator would be an allow for
   * whatever opens it next. Both transports read the principal from the same
   * `res.locals`-shaped facts.
   */
  principal: CallerPrincipal;
}

/**
 * Deliver one session stream to completion.
 *
 * On a COLD connect it emits the server-authoritative snapshot then goes live
 * from that snapshot's cursor, so an event ingested between capture and
 * subscription is replayed rather than lost (single-threaded Node is what makes
 * that gap-free). On a RESUME it SKIPS the snapshot and replays only events
 * above the cursor. A cursor that cannot be served gap-free falls back to the
 * cold path — resuming anyway would leave the client silently missing events or
 * permanently deaf.
 *
 * Never throws: a mid-stream failure is logged and closes the stream, which the
 * client's reconnect handles.
 *
 * @param sink - Where frames go and how a departing reader is noticed.
 * @param plan - What the caller resolved.
 */
export async function deliverSessionStream(
  sink: DurableStreamSink,
  plan: SessionStreamPlan
): Promise<void> {
  const { sessionId, runtime, ctx, sinceCursor, principal } = plan;
  // Resolved ONCE per connection rather than per frame: a principal is fixed
  // for the life of a socket (changing it would need a new handshake), and the
  // room a session answers for cannot change the answer here — only a `bridged`
  // principal reads it, and one never arrives over HTTP.
  const maySeeAsk = askEntitlement(principal, { sessionId }) !== 'none';
  let iterator: AsyncIterator<SessionEvent> | undefined;

  try {
    if (sinceCursor !== undefined) {
      // subscribeSession validates the cursor EAGERLY, so an unservable one
      // throws here rather than silently under-delivering later.
      try {
        iterator = runtime
          .subscribeSession(ctx, sessionId, sinceCursor, sink.signal)
          [Symbol.asyncIterator]();
      } catch (err) {
        if (!(err instanceof StaleResumeCursorError)) throw err;
        logger.info('[session stream] unservable resume cursor — falling back to cold snapshot', {
          sessionId,
          sinceCursor,
        });
      }
    }

    if (!iterator) {
      const snap = await runtime.getSessionSnapshot(ctx, sessionId);
      if (sink.closed) return;
      // Same wire-boundary suppression as GET /:id/messages: the auto-first-turn
      // kickoff (M4) never leaves the server as a user message, whichever
      // runtime stored it. See @dorkos/shared/kickoff for the seam's scope.
      snap.messages = filterKickoffHistory(snap.messages);
      // An Ask's detail — the tool, the command or path, the working directory
      // — rides the snapshot's `pendingInteractions` verbatim. A caller the
      // entitlement refuses gets an empty list rather than an error, the same
      // answer `GET /api/sessions/pending-interactions` gives, so a refusal
      // never says that an Ask exists.
      if (!maySeeAsk) snap.pendingInteractions = [];
      // The snapshot is the hydration frame and carries `cursor`, not a seq, so
      // it gets no frame id — the first live event after it carries the next.
      await sink.send({ event: 'snapshot', data: snap });
      iterator = runtime
        .subscribeSession(ctx, sessionId, snap.cursor, sink.signal)
        [Symbol.asyncIterator]();
    }

    for (;;) {
      const { value, done } = await iterator.next();
      if (done || sink.closed) break;
      // The live half of the same rule. Only the three prompt events are
      // withheld: `interaction_resolved` names no tool and closing a card
      // nobody received is harmless, and everything else on this stream is the
      // session's ordinary output.
      if (!maySeeAsk && isBlockingInteractionEventType(value.type)) continue;
      await sink.send({
        event: value.type,
        data: value,
        id: `${sessionId}-${STREAM_EPOCH}-${value.seq}`,
      });
    }
  } catch (err) {
    if (!sink.closed) {
      logger.warn('[session stream] error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    // Belt-and-suspenders for the replay/idle phases; `sink.signal` is the
    // deterministic teardown for a generator parked on an ingest wait.
    void iterator?.return?.();
    sink.end();
  }
}
