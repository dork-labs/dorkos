/**
 * Handler for `POST /api/sessions/:id/devtools/ingest` — the credentialed sink
 * for preview console/network captures (DOR-213), extracted from `sessions.ts` to
 * keep that route file under the size rule (mirrors `session-ui-action-handler.ts`).
 *
 * The injected shim reports to window.parent. The normal path is the app's
 * authenticated Transport forwarding bounded, correlated page reports to HTTP.
 * Login-off local callers can also reach the route under the existing admission
 * policy; process identity and generation do not authenticate a page script.
 * Browser tools read this buffer as unverified page-reported evidence.
 *
 * The same file answers `POST /api/sessions/:id/devtools/action`, the sink for
 * one driving round trip's result (spec `canvas-agent-seat` §2.1). Same posture,
 * same 204, and the same reason it is a separate route rather than another
 * optional field on the ingest batch: a result is awaited by a tool call and is
 * posted the moment it exists, while a capture batch is coalesced on a 300 ms
 * debounce.
 *
 * @module routes/session-devtools
 */
import type { Context } from 'hono';
import { DevtoolsActionResultSchema, DevtoolsIngestSchema } from '@dorkos/shared/schemas';
import { devtoolsCaptureStore } from '../services/session/index.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { errorBody, parseSessionId } from '../lib/route-utils.js';

const INVALID_SESSION_ID = errorBody('Invalid session ID', 'INVALID_SESSION_ID');

/**
 * Handler for `POST /api/sessions/:id/devtools/ingest`. Zod-validated and
 * size-capped: a batch over a per-array entry limit, a console entry over its
 * serialized `args` size cap, or a screenshot data URL over
 * `DEVTOOLS_SCREENSHOT_MAX_CHARS` is a `413` (distinct from a malformed `400`),
 * so an oversized relay is a clear, debuggable outcome. Accepts any well-formed
 * session id without an existence check — see the inline posture note.
 *
 * @param c - The request context (`:id` route param + `DevtoolsIngest` body);
 *   answers 204 sink / 400 / 413.
 */
export function sessionDevtoolsIngestHandler(c: Context<ApiEnv>): Response {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(INVALID_SESSION_ID, 400);

  const parsed = DevtoolsIngestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    const overCap = parsed.error.issues.some(
      (i) =>
        (i.code === 'too_big' &&
          (i.path[0] === 'console' || i.path[0] === 'network' || i.path[0] === 'screenshot')) ||
        // The console entry `args` serialized-size refine (DEVTOOLS_ARGS_MAX_CHARS)
        // reports a `custom` issue at an entry's `args` path. Matched structurally
        // (never on the message text) so a reworded message can't silently
        // downgrade the oversized outcome to a generic 400.
        (i.code === 'custom' && i.path.at(-1) === 'args')
    );
    if (overCap) {
      return c.json(errorBody('DevTools ingest batch too large', 'BATCH_TOO_LARGE'), 413);
    }
    return c.json(errorBody('Invalid DevTools ingest batch', 'VALIDATION_ERROR'), 400);
  }

  // Deliberately NO session-existence check: like the durable event stream
  // (`session-events-handler.ts`, DOR-74 requirement #1), this sink accepts any
  // WELL-FORMED session id. `hasSession()` is in-memory only — after a server
  // restart, or when a historical session is reopened from its on-disk JSONL,
  // the session isn't tracked until the first turn calls ensureSession, yet the
  // rehydrated preview's PAGE-LOAD captures arrive exactly then. Gating on
  // hasSession would silently drop the page-load errors that Phase 2's
  // `browser_read_console` exists to surface. The permissive posture is safe
  // because the store already bounds abuse: a ~1 MB per-session byte budget and
  // a 50-session LRU cap limit what any made-up id can retain, and buffers are
  // in-memory only. A malformed id is still rejected (400) above.
  // The window's own id, read the way every other handler that needs one reads
  // it — and with NO fallback, which is the difference that matters here.
  //
  // The handlers that lock a session mint a `randomUUID()` when the header is
  // missing, because there a made-up owner is harmless: nobody else holds that
  // id, so nobody else is locked out. A seat is the opposite. The seat is
  // whichever claim is most recent, so a made-up id would TAKE it from the
  // window that really is showing the page — and every driving verb would then
  // address a client that does not exist and time out. A caller with no id
  // still ingests its captures; it simply cannot claim.
  const clientId = c.req.header('x-client-id');

  devtoolsCaptureStore.ingest(sessionId, parsed.data, clientId ? clientId : undefined);
  return c.body(null, 204);
}

/**
 * Handler for `POST /api/sessions/:id/devtools/action` — the sink for
 * one driving round trip's result.
 *
 * Zod-validated and capped the same way the ingest route is; a result that
 * nothing is awaiting (the tool already timed out) is accepted and dropped,
 * because the alternative is an error the client could do nothing about. Accepts
 * any well-formed session id without an existence check, for the reason the
 * ingest handler states below.
 *
 * @param c - The request context (`:id` route param + `DevtoolsActionResult`
 *   body); answers 204 sink / 400.
 */
export function sessionDevtoolsActionHandler(c: Context<ApiEnv>): Response {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(INVALID_SESSION_ID, 400);

  const parsed = DevtoolsActionResultSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json(errorBody('Invalid DevTools action result', 'VALIDATION_ERROR'), 400);
  }

  // Keyed by `requestId` alone, never by session id — a first-turn canonical
  // rekey between the request and the answer must not strand the tool call that
  // is awaiting it. `devtools-capture-store.ts` says why at greater length.
  devtoolsCaptureStore.resolveAction(parsed.data, c.req.header('X-Client-Id'));
  return c.body(null, 204);
}
