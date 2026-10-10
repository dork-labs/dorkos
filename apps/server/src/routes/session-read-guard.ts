/**
 * The one check in front of every `/api/sessions/:id/*` route (spec
 * `audit-trail` §3.4): an agent caller gets 404 for a session it may not read,
 * the same answer as a session that does not exist.
 *
 * Mounted as `router.param('id', ...)` on the sessions router, so it runs for
 * every route and sub-router whose path names `:id`, including ones added
 * later. A route cannot forget it. The owner (no agent header) passes straight
 * through, and so does an id that does not parse, which the route answers 400.
 *
 * **One exception: starting a new chat.** `POST /:id/messages` with
 * `create: true` names an id nobody has used yet, and starting a chat is not
 * reading one. It passes only while no session has that id; one that exists is
 * checked like any other.

 *
 * @module routes/session-read-guard
 */
import type { NextFunction, Request, Response } from 'express';
import { parseSessionId } from '../lib/route-utils.js';
import { sessionExists } from '../services/session/launch/session-exists.js';
import { readerOfRequest, refuseUnreadableSession } from './audit-reader.js';

export { readableSessions } from './audit-reader.js';

/** Whether this request starts a new chat under an id nobody has used. */
async function startsNewSession(req: Request, sessionId: string): Promise<boolean> {
  if (req.method !== 'POST' || req.path !== `/${sessionId}/messages`) return false;
  const body = req.body as { create?: unknown; cwd?: unknown } | undefined;
  if (body?.create !== true) return false;
  const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
  // A lookup that fails counts as "exists": the cautious answer is the check.
  return !(await sessionExists(sessionId, cwd).catch(() => true));
}

/**
 * The `router.param('id', ...)` handler.
 *
 * @param req - The request.
 * @param res - The response; answered 404 on a refusal.
 * @param next - Continues to the route.
 * @param rawId - The `:id` path value.
 */
export async function guardSessionParam(
  req: Request,
  res: Response,
  next: NextFunction,
  rawId: unknown
): Promise<void> {
  const sessionId = parseSessionId(rawId);
  if (!sessionId || readerOfRequest(req, res).kind === 'owner') return next();
  if (await startsNewSession(req, sessionId)) return next();
  if (refuseUnreadableSession(req, res, sessionId)) return;
  next();
}
