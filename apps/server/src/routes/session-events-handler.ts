/**
 * The durable session-event SSE handler for `GET /api/sessions/:id/events`,
 * extracted from `sessions.ts` so that route file stays under the 500-line rule
 * (`.claude/rules/file-size.md`). Behavior is identical to the inline handler it
 * replaced — `sessions.ts` mounts {@link sessionEventsHandler} on the same path.
 *
 * The single delivery path for session state (spec chat-stream-reconnection,
 * Design B.3, ADR-0264/ADR-0266): always-on snapshot → replay → live, with no
 * feature-flag gate. Runtime-agnostic — it speaks the {@link AgentRuntime}
 * snapshot/subscribe contract, never the projector directly, so it works for any
 * runtime (Claude today, the stateless test-mode runtime, future runtimes).
 *
 * @module routes/session-events-handler
 */
import { once } from 'node:events';
import type { NextFunction, Request, Response } from 'express';

/** Route params for `GET /:id/events` — pins `id` to `string` for the handler. */
interface SessionEventsParams {
  id: string;
}
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import { StaleResumeCursorError } from '@dorkos/shared/session-stream';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { initSSEStream, endSSEStream } from '../services/core/stream-adapter.js';
import { assertBoundary, parseSessionId, sendError } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import { SSE } from '../config/constants.js';

const vaultRoot = DEFAULT_CWD;

/**
 * Identifies this server process's seq space in every `id:` frame
 * (`<sid>-<epoch>-<seq>`). Per-session `seq` counters live in in-process
 * projectors and restart from 0 with the process, so a cursor minted by a
 * PREVIOUS process is meaningless in this one — comparing bare integers across
 * a restart can silently validate (client cursor ≤ new counter) and then
 * replay the wrong events. The browser/`SSEConnection` echoes the whole id
 * back as `Last-Event-ID`, so a mismatched epoch routes the reconnect to the
 * cold snapshot path instead of a bogus resume.
 */
export const STREAM_EPOCH = Date.now();

/**
 * Parse the resume cursor from an `/events` request.
 *
 * Precedence: `Last-Event-ID` header (auto-sent by the browser EventSource and
 * the fetch-based `SSEConnection` on reconnect) wins over the `?after=` query.
 * The id frame format is `<sessionId>-<epoch>-<seq>`; the header resumes only
 * when its epoch matches this process's {@link STREAM_EPOCH} — an id minted by
 * a previous server process (or the legacy `<sid>-<seq>` format) falls through
 * to a cold connect. `?after=` is the integer cursor directly (no epoch; it is
 * still validated against the projector's replay window on subscribe).
 * Returns `undefined` for a cold connect.
 *
 * @param lastEventId - The `Last-Event-ID` request header, if any.
 * @param after - The `?after=` query param, if any.
 * @param epoch - This process's stream epoch (injectable for tests).
 */
export function parseResumeCursor(
  lastEventId: string | undefined,
  after: string | undefined,
  epoch: number = STREAM_EPOCH
): number | undefined {
  if (lastEventId) {
    // Take the trailing `-<epoch>-<seq>` so session UUIDs (which contain
    // hyphens) don't break the split — only the final two segments are ours.
    const match = /-(\d+)-(\d+)$/.exec(lastEventId);
    if (match && Number(match[1]) === epoch) return Number(match[2]);
    // Mismatched or absent epoch: the cursor belongs to another seq space —
    // treat as cold rather than resuming into the wrong stream.
    return undefined;
  }
  if (after !== undefined && after !== '') {
    const cursor = Number(after);
    if (Number.isInteger(cursor) && cursor >= 0) return cursor;
  }
  return undefined;
}

/**
 * Express handler for `GET /api/sessions/:id/events`.
 *
 * On a cold connect it emits the server-authoritative snapshot then goes live;
 * with a `Last-Event-ID`/`?after=` resume signal it SKIPS the snapshot and
 * replays only the gap (events with seq > cursor) before going live. This
 * collapses DOR-73 Path A (pull) + Path B (re-emit) into one snapshot+replay
 * mechanism.
 */
export const sessionEventsHandler = async (
  req: Request<SessionEventsParams>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res))) return;

  // Resolve the runtime that owns this session. Unlike GET /:id, we deliberately
  // do NOT 404 an "unknown" session: the durable event stream must be openable
  // for ANY well-formed session id. Two real cases require this (DOR-74,
  // requirement #1):
  //   1. A brand-new client-generated id, opened BEFORE its first message
  //      creates the session server-side (subscribe-first hydration).
  //   2. An existing on-disk session not yet tracked in the in-memory store —
  //      `hasSession()` is in-memory only, but sessions live on disk as JSONL,
  //      so a freshly-loaded server (or a session created by the CLI) would
  //      otherwise 404 a session the sidebar happily lists.
  // The snapshot reads completed messages from disk (empty for a truly-new id),
  // and the live subscription parks on the projector (created on demand), so the
  // connection is healthy from the moment the URL exists and the first turn
  // streams live over it. A malformed id is still rejected (400) by
  // parseSessionId above.
  //
  // The try/catch keeps the RESOLVE failure on the pre-flush path: headers
  // have not been flushed yet (initSSEStream runs below), so the error
  // middleware can still respond with plain JSON. Rejections escaping the
  // whole handler (pre- or post-flush) are forwarded to the error middleware
  // natively by Express 5 — post-flush, Express destroys the socket, which is
  // the correct SSE failure mode (the client reconnects).
  let runtime: AgentRuntime;
  let ctx: SessionOpts;
  try {
    runtime = await runtimeRegistry.resolveForSession(sessionId);

    // Build the SessionOpts context the same way other handlers derive it: the
    // boundary-validated cwd plus the effective permission mode. SessionOpts
    // requires `permissionMode`; the snapshot/subscribe adapter only reads `cwd`,
    // so the persisted mode (or runtime default) is sufficient here.
    const stored = await runtimeRegistry.getSessionSettings(sessionId);
    ctx = {
      cwd,
      permissionMode: stored?.permissionMode ?? 'default',
    };
  } catch (err) {
    return next(err);
  }

  const sinceCursor = parseResumeCursor(
    req.headers['last-event-id'] as string | undefined,
    req.query.after as string | undefined
  );

  // initSSEStream writes the SSE response headers, including `X-Accel-Buffering:
  // no` to defeat proxy buffering on this durable long-lived stream.
  initSSEStream(res);

  // Emit one live SessionEvent as an `id: <sid>-<epoch>-<seq>` framed SSE
  // message. sendSSEEvent does not write the `id:` line, so we prepend it per
  // the SSE spec — the browser echoes it back as `Last-Event-ID` on reconnect,
  // and the epoch lets a restarted server reject the stale seq space.
  //
  // Backpressure: when `write()` returns false the frame is buffered in process
  // memory; awaiting `drain` before the next event bounds that buffer for a
  // slow consumer (a long replay can be thousands of frames). Gap-free delivery
  // is preserved — we pause the send loop, never skip frames — and a client
  // that disconnects mid-wait aborts the `once` via the same signal that tears
  // down the subscription.
  const sendSessionEvent = async (event: SessionEvent): Promise<void> => {
    res.write(`id: ${sessionId}-${STREAM_EPOCH}-${event.seq}\n`);
    const flushed = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (!flushed) await once(res, 'drain', { signal: abortController.signal });
  };

  // Heartbeat comment keeps proxies and the client watchdog from idling out.
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, SSE.HEARTBEAT_INTERVAL_MS);

  // Abort the live subscription on client disconnect. A bare iterator.return()
  // cannot interrupt a generator parked on an un-settleable ingest wait, so the
  // signal is the deterministic teardown that runs the projector's cleanup
  // (removing its parked waiter — the I2 fix). iterator.return() is kept as
  // belt-and-suspenders for the replay/idle phases.
  const abortController = new AbortController();
  let iterator: AsyncIterator<SessionEvent> | undefined;
  let closed = false;
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeatInterval);
    abortController.abort();
    void iterator?.return?.();
  });

  try {
    if (sinceCursor !== undefined) {
      // RESUME connect: SKIP the snapshot; replay only events with seq >
      // sinceCursor from the buffer, then go live. Do NOT resend the snapshot.
      // subscribeSession validates the cursor EAGERLY: if it cannot be served
      // gap-free (replay buffer trimmed past it, or a seq space the epoch check
      // could not catch), fall back to the cold path below — resuming anyway
      // would leave the client silently missing events or permanently deaf.
      try {
        iterator = runtime
          .subscribeSession(ctx, sessionId, sinceCursor, abortController.signal)
          [Symbol.asyncIterator]();
      } catch (err) {
        if (!(err instanceof StaleResumeCursorError)) throw err;
        logger.info('[GET /events] unservable resume cursor — falling back to cold snapshot', {
          sessionId,
          sinceCursor,
        });
      }
    }
    if (!iterator) {
      // COLD connect: emit the snapshot, then go live from snap.cursor so any
      // event ingested between snapshot capture and subscription is replayed
      // (closes the cold-connect race; single-threaded node makes the gap-free).
      const snap = await runtime.getSessionSnapshot(ctx, sessionId);
      if (closed) return;
      // Same wire-boundary suppression as GET /:id/messages: the auto-first-turn
      // kickoff (M4) never leaves the server as a user message, whichever
      // runtime stored it. See @dorkos/shared/kickoff for the seam's scope.
      snap.messages = filterKickoffHistory(snap.messages);
      // Snapshot is the hydration frame (no seq — it carries `cursor`), so it
      // gets no `id:` line; the first live event after it carries the next id.
      res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      iterator = runtime
        .subscribeSession(ctx, sessionId, snap.cursor, abortController.signal)
        [Symbol.asyncIterator]();
    }

    for (;;) {
      const { value, done } = await iterator.next();
      if (done || closed) break;
      await sendSessionEvent(value);
    }
  } catch (err) {
    if (!closed) {
      logger.warn('[GET /events] session stream error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearInterval(heartbeatInterval);
    if (!closed) endSSEStream(res);
  }
};
