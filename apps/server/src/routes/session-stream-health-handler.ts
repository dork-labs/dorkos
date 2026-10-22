/**
 * `POST /api/sessions/:id/stream-health` — an app window saying it missed a
 * turn on a chat it has open.
 *
 * The window notices from two streams that should agree: the fleet-wide
 * `/api/events` stream says this chat ran a turn, and the chat's own durable
 * stream delivered none of it. The window reconnects on its own; this is only
 * how the miss reaches the server log, beside what the server itself knows at
 * that moment, so "the reply only showed after I refreshed" leaves a trail.
 *
 * It lives here rather than in `routes/sessions.ts` to keep that file under the
 * size rule; `session-touch-handler.ts` mounts it beside the app's other
 * per-window signal, `POST /:id/opened`.
 *
 * @module routes/session-stream-health-handler
 */
import type { Context } from 'hono';
import { StreamHealthReportSchema } from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { logger } from '../lib/logger.js';
import { errorBody, parseSessionId } from '../lib/route-utils.js';
import { openSessionStreamCount } from '../services/core/streams/session-stream-watch.js';
import { peekProjector } from '../services/session/index.js';

/**
 * Log a window's report that its stream missed a turn. Always `204` for a
 * well-formed report: the window has nothing to do with the answer.
 *
 * @param c - The request context; `:id` is the chat
 */
export function sessionStreamHealthHandler(c: Context<ApiEnv>): Response {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
  const parsed = StreamHealthReportSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json(errorBody('Invalid request', 'VALIDATION_ERROR'), 400);
  }
  const projector = peekProjector(sessionId);
  logger.warn('[session stream] a window missed a turn and is reconnecting', {
    sessionId,
    ...parsed.data,
    // What the server knew at the same moment: a live subscriber count below
    // the open-window count means a window is reading a feed nobody writes to.
    serverSeq: projector?.getCursor() ?? null,
    serverLifecycle: projector?.getStatus().lifecycle ?? null,
    liveSubscribers: projector?.liveSubscriberCount() ?? 0,
    openWindows: openSessionStreamCount(sessionId),
  });
  return c.body(null, 204);
}
