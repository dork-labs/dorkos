/**
 * The one check in front of every `/api/sessions/:id/*` route (spec
 * `audit-trail` §3.4): an agent caller gets 404 for a session it may not read,
 * the same answer as a session that does not exist.
 *
 * `routes/sessions.ts` puts it in front of every route whose path names `:id`,
 * and of the canvas group mounted under one, the way `router.param('id', ...)`
 * did on Express: it runs only for a request a session route matched. The owner
 * (no agent header) passes straight through, and so does an id that does not
 * parse, which the route answers 400.
 *
 * **One exception: starting a new chat.** `POST /:id/messages` with
 * `create: true` names an id nobody has used yet, and starting a chat is not
 * reading one. It passes only while no session has that id; one that exists is
 * checked like any other.
 *
 * @module routes/session-read-guard
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { parseSessionId } from '../lib/route-utils.js';
import { sessionExists } from '../services/session/launch/session-exists.js';
import { canReadSession, readerOfRequest, SESSION_NOT_FOUND_BODY } from './audit-reader.js';

export { readableSessions } from './audit-reader.js';

/** Whether this request starts a new chat under an id nobody has used. */
async function startsNewSession(c: Context<ApiEnv>, sessionId: string): Promise<boolean> {
  if (c.req.method !== 'POST' || !c.req.path.endsWith(`/${sessionId}/messages`)) return false;
  const body = readJsonBody(c) as { create?: unknown; cwd?: unknown } | undefined;
  if (body?.create !== true) return false;
  const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
  // A lookup that fails counts as "exists": the cautious answer is the check.
  return !(await sessionExists(sessionId, cwd).catch(() => true));
}

/** The guard, as middleware in front of a session route. */
export const guardSessionParam: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return next();
  const facts = honoRequestFacts(c);
  if (readerOfRequest(facts).kind === 'owner') return next();
  if (await startsNewSession(c, sessionId)) return next();
  if (!canReadSession(facts, sessionId)) return c.json(SESSION_NOT_FOUND_BODY, 404);
  await next();
};
