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
import type { RequestHandler } from 'express';

/** Route params for `GET /:id/events` — pins `id` to `string` for the handler. */
interface SessionEventsParams {
  id: string;
}
import type { SessionOpts } from '@dorkos/shared/agent-runtime';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { initSSEStream, endSSEStream } from '../services/core/stream-adapter.js';
import { assertBoundary, parseSessionId, sendError } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import { SSE } from '../config/constants.js';

const vaultRoot = DEFAULT_CWD;

/**
 * Parse the resume cursor from an `/events` request.
 *
 * Precedence: `Last-Event-ID` header (auto-sent by the browser EventSource and
 * the fetch-based `SSEConnection` on reconnect) wins over the `?after=` query.
 * The id frame format is `<sessionId>-<seq>`, so the trailing `-<seq>` integer
 * is extracted from the header; `?after=` is the integer cursor directly.
 * Returns `undefined` for a cold connect (neither signal present or unparseable).
 *
 * @param lastEventId - The `Last-Event-ID` request header, if any.
 * @param after - The `?after=` query param, if any.
 */
export function parseResumeCursor(
  lastEventId: string | undefined,
  after: string | undefined
): number | undefined {
  if (lastEventId) {
    // Take the trailing `-<digits>` so session UUIDs (which contain hyphens)
    // don't break the split — only the final segment is the seq.
    const match = /-(\d+)$/.exec(lastEventId);
    if (match) return Number(match[1]);
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
export const sessionEventsHandler: RequestHandler<SessionEventsParams> = async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res))) return;

  // Resolve the runtime that owns this session and confirm it exists — 404 for
  // an unknown session, matching the pending-interactions / GET /:id pattern.
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  if (!runtime.hasSession(sessionId)) {
    return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  }

  // Build the SessionOpts context the same way other handlers derive it: the
  // boundary-validated cwd plus the effective permission mode. SessionOpts
  // requires `permissionMode`; the snapshot/subscribe adapter only reads `cwd`,
  // so the persisted mode (or runtime default) is sufficient here.
  const stored = await runtimeRegistry.getSessionSettings(sessionId);
  const ctx: SessionOpts = {
    cwd,
    permissionMode: stored?.permissionMode ?? 'default',
  };

  const sinceCursor = parseResumeCursor(
    req.headers['last-event-id'] as string | undefined,
    req.query.after as string | undefined
  );
  const isResume = sinceCursor !== undefined;

  // initSSEStream writes the SSE response headers, including `X-Accel-Buffering:
  // no` to defeat proxy buffering on this durable long-lived stream.
  initSSEStream(res);

  // Emit one live SessionEvent as an `id: <sid>-<seq>` framed SSE message.
  // sendSSEEvent does not write the `id:` line, so we prepend it per the SSE
  // spec — the browser echoes it back as `Last-Event-ID` on reconnect.
  const sendSessionEvent = (event: SessionEvent): void => {
    res.write(`id: ${sessionId}-${event.seq}\n`);
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
    if (!isResume) {
      // COLD connect: emit the snapshot, then go live from snap.cursor so any
      // event ingested between snapshot capture and subscription is replayed
      // (closes the cold-connect race; single-threaded node makes the gap-free).
      const snap = await runtime.getSessionSnapshot(ctx, sessionId);
      if (closed) return;
      // Snapshot is the hydration frame (no seq — it carries `cursor`), so it
      // gets no `id:` line; the first live event after it carries the next id.
      res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      iterator = runtime
        .subscribeSession(ctx, sessionId, snap.cursor, abortController.signal)
        [Symbol.asyncIterator]();
    } else {
      // RESUME connect: SKIP the snapshot; replay only events with seq >
      // sinceCursor from the buffer, then go live. Do NOT resend the snapshot.
      iterator = runtime
        .subscribeSession(ctx, sessionId, sinceCursor, abortController.signal)
        [Symbol.asyncIterator]();
    }

    for (;;) {
      const { value, done } = await iterator.next();
      if (done || closed) break;
      sendSessionEvent(value);
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
