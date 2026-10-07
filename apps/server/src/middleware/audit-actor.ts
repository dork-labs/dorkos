/**
 * Enter the audit actor scope for every request (spec `audit-trail` §3.3).
 *
 * Mounted right after `resolveAgentIdentity`, so it can read what the identity
 * and session gates already decided rather than deciding again. Everything a
 * route or service records while handling the request is attributed to this
 * actor, unless a deeper edge (a tool call) enters a narrower scope.
 *
 * | The caller                                    | Actor                          | Credential   | Surface |
 * | --------------------------------------------- | ------------------------------ | ------------ | ------- |
 * | Presents `X-DorkOS-Agent`, resolved           | that agent                     | agent-token  | `http` (`mcp` on `/mcp`) |
 * | Presents `X-DorkOS-Agent`, not resolved       | `unidentified`                 | agent-token  | same    |
 * | A per-user API key                            | that account                   | api-key      | same    |
 * | A browser session cookie                      | that account                   | cookie       | `app`   |
 * | The per-install local token on `/mcp`         | the owner                      | mcp-local    | `mcp`   |
 * | Nothing (login off)                           | the owner                      | none         | `app`   |
 *
 * The agent question is asked first, for the reason `lib/caller-principal.ts`
 * gives: an agent may legitimately hold one of the person's API keys.
 *
 * ## Lazy, and why
 *
 * Naming an actor reads the database (the owner account, an agent's mesh id),
 * and most requests are reads that record nothing. So the actor and credential
 * are worked out the first time something asks, and remembered for the rest of
 * the request. Lazy also means a gate that runs AFTER this middleware (the
 * `/mcp` authorizer sets `res.locals.user` itself) is still seen.
 *
 * @module middleware/audit-actor
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuditActor, AuditEvent, AuditSurface } from '@dorkos/shared/audit-schemas';
import { runWithAuditActor, type AuditActorContext } from '../services/audit/audit-context.js';
import {
  AGENT_IDENTITY_HEADER,
  getRequestAgentIdentity,
  presentsAgentIdentity,
} from './agent-identity.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { auditTrail, type AuditTrail } from '../services/audit/audit-trail.js';
import { credentialRef } from '../services/audit/account-ids.js';

type RequestLike = Pick<Request, 'headers' | 'path'>;
type ResponseLike = Pick<Response, 'locals'>;

/** Who a request is, worked out once, on first use. */
class RequestAuditScope implements AuditActorContext {
  recorded?: boolean;
  private resolved?: { actor: AuditActor; credential?: AuditEvent['credential'] };

  constructor(
    private readonly trail: AuditTrail,
    private readonly req: RequestLike,
    private readonly res: ResponseLike,
    readonly surface: AuditSurface
  ) {}

  get actor(): AuditActor {
    return this.resolve().actor;
  }

  get credential(): AuditEvent['credential'] | undefined {
    return this.resolve().credential;
  }

  private resolve(): { actor: AuditActor; credential?: AuditEvent['credential'] } {
    if (!this.resolved) this.resolved = resolveRequestActor(this.trail, this.req, this.res);
    return this.resolved;
  }
}

/** The actor and credential behind one request, read off what the gates decided. */
function resolveRequestActor(
  trail: AuditTrail,
  req: RequestLike,
  res: ResponseLike
): { actor: AuditActor; credential?: AuditEvent['credential'] } {
  if (presentsAgentIdentity(req, res)) {
    const header = req.headers[AGENT_IDENTITY_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    return {
      actor: trail.accounts.forAgentIdentity(getRequestAgentIdentity(res)),
      // The same reference the token's `agent_token.minted` row carries, so a
      // use can be matched to the session it was minted for.
      ...(token ? { credential: credentialRef('agent-token', token) } : {}),
    };
  }
  const user = res.locals.user as RequestUser | undefined;
  if (user) {
    return {
      actor: trail.accounts.forUser(user.userId),
      credential:
        user.credential === 'api-key'
          ? credentialRef('api-key', user.credentialId ?? user.userId)
          : credentialRef('cookie', user.userId),
    };
  }
  if (res.locals.mcpLocalToken === true) {
    return { actor: trail.accounts.owner(), credential: credentialRef('mcp-local', 'local-token') };
  }
  return { actor: trail.accounts.owner() };
}

/**
 * The audit scope for one request, or `undefined` when no trail is set up.
 * Nothing is read from the database until the scope's actor is first asked for.
 *
 * @param req - The request, for the agent header and the path.
 * @param res - The response, for what the gates resolved.
 */
export function auditActorForRequest(
  req: RequestLike,
  res: ResponseLike
): AuditActorContext | undefined {
  const trail = auditTrail();
  if (!trail) return undefined;
  const viaMcp = req.path === '/mcp' || req.path.startsWith('/mcp/');
  const programmatic = presentsAgentIdentity(req, res) || res.locals.user?.credential === 'api-key';
  const surface: AuditSurface = viaMcp ? 'mcp' : programmatic ? 'http' : 'app';
  return new RequestAuditScope(trail, req, res, surface);
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
  res.locals.auditScope = scope;
  runWithAuditActor(scope, () => next());
}
