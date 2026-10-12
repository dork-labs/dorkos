/**
 * `GET /api/sessions/:id/events` over Server-Sent Events.
 *
 * This is the PUBLIC integration contract (`docs/integrations/sse-protocol.mdx`)
 * — third-party clients are built against it, and the Electron main process
 * reads its sibling `/api/events` for the tray count. The app itself moved
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
import type { Context } from 'hono';
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import { STREAM_RESUME_PARAM } from '@dorkos/shared/stream-socket';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { docScopeNotifications } from '../services/canvas/doc-channel/streams/registry.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { resolveSessionCwdOrDefault, resolveSettingsKey } from '../services/session/index.js';
import { deliverSessionStream } from '../services/core/streams/session-stream-delivery.js';
import { SseStreamSink } from '../services/core/streams/durable-stream-sink.js';
import { boundaryRefusal, errorBody, parseSessionId } from '../lib/route-utils.js';
import { parseResumeCursor } from '../lib/stream-cursor.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';

/**
 * Handler for `GET /api/sessions/:id/events`.
 *
 * On a cold connect it emits the server-authoritative snapshot then goes live;
 * with a `Last-Event-ID`/`?after=` resume signal it SKIPS the snapshot and
 * replays only the gap (events with seq > cursor) before going live. This
 * collapses DOR-73 Path A (pull) + Path B (re-emit) into one snapshot+replay
 * mechanism.
 *
 * The stream is written straight to the Node response
 * (`http/raw-node-stream.ts`), so the frames are the bytes the sink writes.
 * Anything thrown before the head is answered as JSON by the chain's error
 * handler; after it, the chain closes the connection, which is the correct SSE
 * failure mode (the client reconnects).
 *
 * @param c - The request context.
 */
export async function sessionEventsHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

  const query = readQuery(c);
  const cwdParam = (query.cwd as string) || undefined;

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
  // A failure here is thrown before the head is written, so the chain's error
  // handler still answers it as plain JSON.
  const runtime: AgentRuntime = await runtimeRegistry.resolveForSession(sessionId, {
    allowUnbound: true,
  });
  // The key goes through the shared resolver — the raw request id is an ALIAS
  // once the runtime binds a canonical one, and the store is keyed canonically
  // (DOR-463).
  const stored = await runtimeRegistry.getSessionSettings(resolveSettingsKey(sessionId, runtime));
  // No `?cwd=` is required for a session the runtime can already place
  // (DOR-1444): a second window that opened the session URL without `&dir=`
  // used to stream against the server's DEFAULT project directory, which
  // hydrates from the wrong transcript — and, when that default sits outside
  // the configured boundary, was refused outright, so the window never bound
  // and the turn running right then was invisible to it.
  const cwd = await resolveSessionCwdOrDefault(runtime, sessionId, cwdParam);
  const ctx: SessionOpts = { cwd, permissionMode: stored?.permissionMode ?? 'default' };

  // The directory nobody named still has to be judged, and only the resolution
  // above knows which one that is. An agent-home session cwd ({dorkHome}/agents/*)
  // must stream under a narrow boundary; this is the landing path for
  // onboarding's DorkBot session.
  const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
  if (outside) return c.json(outside, 403);

  const resume = parseResumeCursor(
    c.req.header('last-event-id') ?? (query[STREAM_RESUME_PARAM] as string | undefined),
    query.after as string | undefined
  );
  // The chain has already run the session gate and agent identity, so this is
  // the same read the fleet-wide surfaces make.
  const facts = honoRequestFacts(c);

  return streamToNodeResponse(c, (res) =>
    deliverSessionStream(new SseStreamSink(res), {
      sessionId,
      runtime,
      ctx,
      // No `resourceId` is passed to the parse above, deliberately: a session's
      // projector can be rekeyed from its request id to its canonical id, and the
      // client that followed it there is resuming the SAME seq space. The
      // generation is what judges that — correctly, and in both directions.
      resume,
      principal: readCallerPrincipal(facts),
      documentNotifications: docScopeNotifications(
        `session:${sessionId}`,
        { headers: facts.headers },
        { locals: { agentIdentity: facts.agentIdentity, user: facts.user } }
      ),
    })
  );
}
