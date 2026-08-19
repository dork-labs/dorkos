/**
 * `GET /api/sessions/:id/events` over Server-Sent Events.
 *
 * This is the PUBLIC integration contract (`docs/integrations/sse-protocol.mdx`)
 * — third-party clients are built against it, and the Electron main process
 * reads its sibling `/api/events` for the tray count. The cockpit itself moved
 * to the WebSocket at the same path (`session-events-socket.ts`) because an SSE
 * stream holds one of a browser's ~6 sockets per origin and three windows spent
 * all six (ADR 260805-041016). Both are first-class; neither is a fallback.
 *
 * The two share everything that matters: this file resolves the same
 * {@link SessionStreamPlan} the socket route resolves and hands it to the same
 * {@link deliverSessionStream}. Only the sink differs.
 *
 * @module routes/session-events-handler
 */
import type { NextFunction, Request, Response } from 'express';
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import { STREAM_RESUME_PARAM } from '@dorkos/shared/stream-socket';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { resolveSettingsKey } from '../services/session/index.js';
import { deliverSessionStream } from '../services/core/streams/session-stream-delivery.js';
import { SseStreamSink } from '../services/core/streams/durable-stream-sink.js';
import { assertBoundary, parseSessionId, sendError } from '../lib/route-utils.js';
import { parseResumeCursor } from '../lib/stream-cursor.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';

/** Route params for `GET /:id/events` — pins `id` to `string` for the handler. */
interface SessionEventsParams {
  id: string;
}

const vaultRoot = DEFAULT_CWD;

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
  // Agent-home session cwds ({dorkHome}/agents/*) must stream under a narrow
  // boundary — this is the landing path for onboarding's DorkBot session.
  if (!(await assertBoundary(cwd, res, { allowDorkHome: true }))) return;

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
  //
  // The try/catch keeps the RESOLVE failure on the pre-flush path: headers have
  // not been flushed yet, so the error middleware can still respond with plain
  // JSON. Rejections escaping the whole handler are forwarded to the error
  // middleware natively by Express 5 — post-flush, Express destroys the socket,
  // which is the correct SSE failure mode (the client reconnects).
  let runtime: AgentRuntime;
  let ctx: SessionOpts;
  try {
    runtime = await runtimeRegistry.resolveForSession(sessionId);
    // The key goes through the shared resolver — the raw request id is an ALIAS
    // once the runtime binds a canonical one, and the store is keyed canonically
    // (DOR-463).
    const stored = await runtimeRegistry.getSessionSettings(resolveSettingsKey(sessionId, runtime));
    ctx = { cwd, permissionMode: stored?.permissionMode ?? 'default' };
  } catch (err) {
    return next(err);
  }

  const sinceCursor = parseResumeCursor(
    (req.headers['last-event-id'] as string | undefined) ??
      (req.query[STREAM_RESUME_PARAM] as string | undefined),
    req.query.after as string | undefined
  );

  await deliverSessionStream(new SseStreamSink(res), {
    sessionId,
    runtime,
    ctx,
    sinceCursor,
    // The Express chain has already run `sessionGate` and `resolveAgentIdentity`,
    // so this is the same read the fleet-wide surfaces make.
    principal: readCallerPrincipal(req, res),
  });
};
