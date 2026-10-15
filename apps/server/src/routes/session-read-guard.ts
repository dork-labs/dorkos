/**
 * The one check in front of every `/api/sessions/:id/*` route (spec
 * `audit-trail` §3.4): an agent caller gets 404 for a session it may not read,
 * the same answer as a session that does not exist.
 *
 * `routes/sessions.ts` registers it once, as middleware on `/:id/*` ahead of
 * every route, so it covers each route under a session id by construction, the
 * way `router.param('id', ...)` did on Express, a route added later included.
 * The owner (no agent header) passes straight through, and so does an id that
 * does not parse: a static path such as `/recent`, which its own route answers,
 * or a malformed id, which the route answers 400. So does a path no session
 * route answers, which gets the `/api` 404 like any other unknown path.
 *
 * **One exception: starting a new chat.** `POST /:id/messages` with
 * `create: true` names an id nobody has used yet, and starting a chat is not
 * reading one. It passes only while no session has that id; one that exists is
 * checked like any other.
 *
 * @module routes/session-read-guard
 */
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
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

/**
 * Whether a route under the guard's own path answers this request. The guard is
 * registered on `/:id/*`, which matches every path under a session id, a path no
 * route has included; that one keeps the `/api` 404 the chain gives any unknown
 * path. Any route under the same prefix counts, middleware included, so the
 * doubtful case is checked rather than passed.
 */
function answeredBySessionRoute(c: Context<ApiEnv>): boolean {
  const routes = matchedRoutes(c);
  const own = c.req.routeIndex;
  const scope = routes[own]?.path.replace(/\/\*$/, '') ?? '';
  return routes.some((route, index) => index !== own && route.path.startsWith(scope));
}

/** The guard, as middleware in front of every session route. */
export const guardSessionParam: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId || !answeredBySessionRoute(c)) return next();
  const facts = honoRequestFacts(c);
  if (readerOfRequest(facts).kind === 'owner') return next();
  if (await startsNewSession(c, sessionId)) return next();
  if (!canReadSession(facts, sessionId)) return c.json(SESSION_NOT_FOUND_BODY, 404);
  await next();
};
