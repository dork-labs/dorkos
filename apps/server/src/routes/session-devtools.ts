/**
 * Handler for `POST /api/sessions/:id/devtools/ingest` — the credentialed sink
 * for preview console/network captures (DOR-213), extracted from `sessions.ts` to
 * keep that route file under the size rule (mirrors `session-ui-action-handler.ts`).
 *
 * The injected in-page shim posts captures to `window.parent`, never to `/api/*`
 * (it can't: opaque origin, no credentials). The DorkOS **client** — same-origin
 * and authenticated — is the only party that reaches this route, so it passes the
 * app-wide session gate normally; the trust boundary stays exactly where DOR-216
 * put it. This route just validates the batch and appends it to the session's
 * bounded capture buffer. It is a sink (204), never a read surface — the agent
 * reads the buffer through an MCP tool, which lands in a follow-up phase.
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
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { DevtoolsActionResultSchema, DevtoolsIngestSchema } from '@dorkos/shared/schemas';
import { devtoolsCaptureStore } from '../services/session/index.js';
import { parseSessionId, sendError } from '../lib/route-utils.js';

/**
 * Express handler for `POST /api/sessions/:id/devtools/ingest`. Zod-validated and
 * size-capped: a batch over a per-array entry limit, a console entry over its
 * serialized `args` size cap, or a screenshot data URL over
 * `DEVTOOLS_SCREENSHOT_MAX_CHARS` is a `413` (distinct from a malformed `400`),
 * so an oversized relay is a clear, debuggable outcome. Accepts any well-formed
 * session id without an existence check — see the inline posture note.
 *
 * @param req - The Express request (`:id` route param + `DevtoolsIngest` body).
 * @param res - The Express response (204 sink / 400 / 413).
 */
export async function sessionDevtoolsIngestHandler(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = DevtoolsIngestSchema.safeParse(req.body);
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
      return sendError(res, 413, 'DevTools ingest batch too large', 'BATCH_TOO_LARGE');
    }
    return sendError(res, 400, 'Invalid DevTools ingest batch', 'VALIDATION_ERROR');
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
  // it (`routes/sessions.ts`, `session-ui-action-handler.ts`): the header, or a
  // per-request UUID when a client sends none. A client with no id simply never
  // wins a seat it did not claim — the fallback is stable for this request and
  // nothing else, so it can never collide with a real window's claim.
  const clientId = (req.headers['x-client-id'] as string) || randomUUID();

  devtoolsCaptureStore.ingest(sessionId, parsed.data, clientId);
  res.status(204).end();
}

/**
 * Express handler for `POST /api/sessions/:id/devtools/action` — the sink for
 * one driving round trip's result.
 *
 * Zod-validated and capped the same way the ingest route is; a result that
 * nothing is awaiting (the tool already timed out) is accepted and dropped,
 * because the alternative is an error the client could do nothing about. Accepts
 * any well-formed session id without an existence check, for the reason the
 * ingest handler states below.
 *
 * @param req - The Express request (`:id` route param + `DevtoolsActionResult` body).
 * @param res - The Express response (204 sink / 400).
 */
export async function sessionDevtoolsActionHandler(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = DevtoolsActionResultSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid DevTools action result', 'VALIDATION_ERROR');
  }

  // Keyed by `requestId` alone, never by session id — a first-turn canonical
  // rekey between the request and the answer must not strand the tool call that
  // is awaiting it. `devtools-capture-store.ts` says why at greater length.
  devtoolsCaptureStore.resolveAction(parsed.data);
  res.status(204).end();
}
