/**
 * `GET /api/sessions/:id/events` over a WebSocket — what the cockpit uses.
 *
 * Same path, same durable contract, same sequencing as the SSE handler beside
 * it (`session-events-handler.ts`): both resolve a {@link SessionStreamPlan} and
 * hand it to {@link deliverSessionStream}. Only the sink differs, and only
 * because of a browser limit — an SSE stream holds one of a browser's ~6 sockets
 * per origin for as long as it is open, so three cockpit windows spent all six
 * and every later request queued forever (ADR 260805-041016).
 *
 * Two mechanics differ from SSE, both because a browser `WebSocket` constructor
 * takes a URL and nothing else:
 *
 * - The resume cursor arrives as `?resume=` rather than the `Last-Event-ID`
 *   header. It is still the whole frame id, so the epoch check that rejects a
 *   cursor from a previous server process is intact.
 * - Everything the SSE handler decides before flushing headers is decided here
 *   in `authorize`, before the handshake — so a bad id, an out-of-boundary cwd
 *   or a failed runtime resolve is still an answer rather than a socket that
 *   opens and dies.
 *
 * @module routes/session-events-socket
 */
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import { STREAM_RESUME_PARAM } from '@dorkos/shared/stream-socket';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { resolveSessionCwdOrDefault, resolveSettingsKey } from '../services/session/index.js';
import { deliverSessionStream } from '../services/core/streams/session-stream-delivery.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { DurableStreamSocket } from '../services/core/streams/stream-socket.js';
import type { UpgradeDecision, UpgradeRoute } from '../services/core/streams/upgrade-router.js';
import { validateBoundaryOrDorkHome, BoundaryError } from '../lib/boundary.js';
import { parseSessionId } from '../lib/route-utils.js';
import { parseResumeCursor } from '../lib/stream-cursor.js';
import { logger } from '../lib/logger.js';

/** Matches `/api/sessions/:id/events`, capturing the session id. */
const SESSION_EVENTS_PATH = /^\/api\/sessions\/([^/]+)\/events$/;

/**
 * The upgrade route for a session's durable event stream.
 *
 * Unlike `GET /api/sessions/:id`, an UNKNOWN session is deliberately not a 404:
 * the durable stream must be openable for ANY well-formed session id. Two real
 * cases require it (DOR-74, requirement #1) — a brand-new client-generated id
 * opened before its first message creates the session server-side, and an
 * existing on-disk session not yet in the in-memory store. The snapshot reads
 * completed messages from disk (empty for a truly-new id) and the live
 * subscription parks on the projector, so the connection is healthy from the
 * moment the URL exists. A malformed id is still rejected.
 */
export const sessionEventsRoute: UpgradeRoute = {
  name: 'session-events',
  pattern: SESSION_EVENTS_PATH,
  // The router runs the credential gate before this is called.
  credential: 'required',

  async authorize({ url, match, headers, locals }): Promise<UpgradeDecision> {
    // Refusals go out as a close frame rather than a failed handshake: a
    // browser cannot read the status of a failed one, and a signed-out cockpit
    // has to be able to tell "not yours to read" from "server briefly down".
    const refuse = (status: number, message: string): UpgradeDecision => ({
      ok: false,
      status,
      message,
      deliver: 'close-frame',
    });

    const sessionId = parseSessionId(decodeURIComponent(match[1]!));
    if (!sessionId) return refuse(400, 'Invalid session ID');

    const cwdParam = url.searchParams.get('cwd') || undefined;
    /** Judge one directory against the boundary; a refusal is the decision. */
    const denyIfOutsideBoundary = async (dir: string): Promise<UpgradeDecision | undefined> => {
      try {
        await validateBoundaryOrDorkHome(dir);
        return undefined;
      } catch (err) {
        if (err instanceof BoundaryError) return refuse(403, 'Forbidden');
        throw err;
      }
    };

    // A directory the caller NAMED is judged before anything else is consulted.
    // Agent-home session cwds ({dorkHome}/agents/*) must stream under a narrow
    // boundary — this is the landing path for onboarding's DorkBot session.
    if (cwdParam !== undefined) {
      const denied = await denyIfOutsideBoundary(cwdParam);
      if (denied) return denied;
    }

    // Resolve the runtime that owns this session, and build the SessionOpts
    // context the way the SSE handler derives it: the resolved cwd plus the
    // effective permission mode. The key goes through the shared resolver — the
    // raw request id is an ALIAS once the runtime binds a canonical one, and the
    // store is keyed canonically (DOR-463).
    let runtime: AgentRuntime;
    let ctx: SessionOpts;
    let cwd: string;
    try {
      runtime = await runtimeRegistry.resolveForSession(sessionId);
      const stored = await runtimeRegistry.getSessionSettings(
        resolveSettingsKey(sessionId, runtime)
      );
      // No `?cwd=` is required for a session the runtime can already place
      // (DOR-1444) — the same ladder the SSE handler climbs. This is the path
      // the cockpit uses, so it is the one a second window opened without
      // `&dir=` was refused on while a turn was streaming into the first.
      cwd = resolveSessionCwdOrDefault(runtime, sessionId, cwdParam);
      ctx = { cwd, permissionMode: stored?.permissionMode ?? 'default' };
    } catch (err) {
      logger.warn('[ws session] runtime resolve failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return refuse(500, 'Internal Server Error');
    }

    // The directory nobody named still has to be judged, and only the
    // resolution above knows which one that is.
    if (cwdParam === undefined) {
      const denied = await denyIfOutsideBoundary(cwd);
      if (denied) return denied;
    }

    const sinceCursor = parseResumeCursor(
      url.searchParams.get(STREAM_RESUME_PARAM) ?? undefined,
      url.searchParams.get('after') ?? undefined
    );

    return {
      ok: true,
      open: (ws) => {
        void deliverSessionStream(new DurableStreamSocket(ws), {
          sessionId,
          runtime,
          ctx,
          sinceCursor,
          // `StreamUpgradeLocals` is `res.locals`-shaped precisely so this
          // reads the same principal an HTTP request would.
          principal: readCallerPrincipal({ headers }, { locals }),
        });
      },
    };
  },
};
