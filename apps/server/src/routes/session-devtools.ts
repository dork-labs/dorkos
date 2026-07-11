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
 * @module routes/session-devtools
 */
import type { Request, Response } from 'express';
import { DevtoolsIngestSchema } from '@dorkos/shared/schemas';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { devtoolsCaptureStore } from '../services/session/index.js';
import { parseSessionId, sendError } from '../lib/route-utils.js';

/**
 * Express handler for `POST /api/sessions/:id/devtools/ingest`. Zod-validated and
 * size-capped: a batch over a per-array entry limit — or a console entry over its
 * serialized `args` size cap — is a `413` (distinct from a malformed `400`), so an
 * oversized relay is a clear, debuggable outcome. Unknown sessions 404 (mirroring
 * `/ui-action`): a capture can only exist because an existing session's preview
 * produced it, so a made-up id must never accumulate a buffer.
 *
 * @param req - The Express request (`:id` route param + `DevtoolsIngest` body).
 * @param res - The Express response (204 sink / 400 / 404 / 413).
 */
export async function sessionDevtoolsIngestHandler(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = DevtoolsIngestSchema.safeParse(req.body);
  if (!parsed.success) {
    const overCap = parsed.error.issues.some(
      (i) =>
        (i.code === 'too_big' && (i.path[0] === 'console' || i.path[0] === 'network')) ||
        // The console entry `args` serialized-size refine (DEVTOOLS_ARGS_MAX_CHARS).
        (i.code === 'custom' && i.message.includes('size cap'))
    );
    if (overCap) {
      return sendError(res, 413, 'DevTools ingest batch too large', 'BATCH_TOO_LARGE');
    }
    return sendError(res, 400, 'Invalid DevTools ingest batch', 'VALIDATION_ERROR');
  }

  // A capture belongs to a session the operator has open; an unknown id is a
  // client bug (or a probe) — never create-on-ingest. Same posture as /ui-action.
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  if (!runtime.hasSession(sessionId)) {
    return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  }

  devtoolsCaptureStore.ingest(sessionId, parsed.data);
  res.status(204).end();
}
