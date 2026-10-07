/**
 * Enter the audit actor scope for every request (spec `audit-trail` §3.3).
 *
 * Mounted right after `resolveAgentIdentity`, so it can read what the identity
 * and session gates already decided rather than deciding again. Everything a
 * route or service records while handling the request is attributed to this
 * actor, unless a deeper edge (a tool call) enters a narrower scope.
 *
 * | The caller                                    | Actor                          | Surface |
 * | --------------------------------------------- | ------------------------------ | ------- |
 * | Presents `X-DorkOS-Agent`, resolved           | that agent                     | `http` (`mcp` on `/mcp`) |
 * | Presents `X-DorkOS-Agent`, not resolved       | `unidentified`                 | same    |
 * | A per-user API key                            | that account                   | same    |
 * | A browser session cookie                      | that account                   | `app`   |
 * | Nothing (login off)                           | the owner                      | `app`   |
 *
 * The agent question is asked first, for the reason `lib/caller-principal.ts`
 * gives: an agent may legitimately hold one of the person's API keys.
 *
 * @module middleware/audit-actor
 */
import type { NextFunction, Request, Response } from 'express';
import { runWithAuditActor, type AuditActorContext } from '../services/audit/audit-context.js';
import { getRequestAgentIdentity, presentsAgentIdentity } from './agent-identity.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { auditTrail } from '../services/audit/audit-trail.js';
import { credentialRef } from '../services/audit/account-ids.js';

/**
 * The audit scope for one request, or `undefined` when no trail is set up.
 *
 * @param req - The request, for the agent header and the path.
 * @param res - The response, for what the gates resolved.
 */
export function auditActorForRequest(
  req: Pick<Request, 'headers' | 'path'>,
  res: Pick<Response, 'locals'>
): AuditActorContext | undefined {
  const trail = auditTrail();
  if (!trail) return undefined;
  const viaMcp = req.path === '/mcp' || req.path.startsWith('/mcp/');
  if (presentsAgentIdentity(req, res)) {
    const identity = getRequestAgentIdentity(res);
    return {
      actor: trail.accounts.forAgentIdentity(identity),
      surface: viaMcp ? 'mcp' : 'http',
    };
  }
  const user = res.locals.user as RequestUser | undefined;
  if (user?.credential === 'api-key') {
    return {
      actor: trail.accounts.forUser(user.userId),
      surface: viaMcp ? 'mcp' : 'http',
      ...(user.credentialId ? { credential: credentialRef('api-key', user.credentialId) } : {}),
    };
  }
  if (user) return { actor: trail.accounts.forUser(user.userId), surface: viaMcp ? 'mcp' : 'app' };
  return { actor: trail.accounts.owner(), surface: viaMcp ? 'mcp' : 'app' };
}

/**
 * Express middleware: run the rest of the request inside its audit scope.
 *
 * @param req - The request.
 * @param res - The response.
 * @param next - The next handler.
 */
export function auditActor(req: Request, res: Response, next: NextFunction): void {
  const scope = auditActorForRequest(req, res);
  if (!scope) return next();
  runWithAuditActor(scope, () => next());
}
