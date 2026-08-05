/**
 * Resolve an agent identity from the `X-DorkOS-Agent` header onto the request
 * context (spec `agent-trust` §3.1).
 *
 * Mounted app-wide immediately after `sessionGate`, so it covers both the
 * `/api/*` surface and the external `/mcp` mount that `index.ts` adds to the
 * same app. It is purely additive: it reads a header, and on success attaches
 * {@link AgentIdentity} to `res.locals.agentIdentity` (the same place
 * `sessionGate` puts `res.locals.user`).
 *
 * ## This middleware never rejects a request
 *
 * Absent, unknown, malformed, or revoked tokens all fall through to today's
 * unattributed behavior — identity is attribution, not authorization (spec
 * §3.1, resolved open question: mandatory identity would break external MCP
 * clients and human CLI use for no security gain, since transport auth already
 * guards these surfaces). It also does not alter any existing auth outcome:
 * `sessionGate` has already decided whether the request may proceed by the time
 * this runs.
 *
 * @module middleware/agent-identity
 */
import type { Request, Response, NextFunction } from 'express';
import {
  agentTokenDigestPrefix,
  getAgentIdentityService,
  type AgentIdentity,
} from '../services/core/agent-identity/agent-identity-service.js';
import { logger } from '../lib/logger.js';

/** The header an agent presents its minted identity token in. */
export const AGENT_IDENTITY_HEADER = 'x-dorkos-agent';

/**
 * Read the resolved agent identity a request carries, or `undefined` when the
 * caller is the human operator or an unattributed client.
 *
 * Use this instead of touching `res.locals` directly so the storage location
 * stays a single-file detail.
 *
 * @param res - Anything holding the request-scoped locals — an Express
 *   `Response`, or the locals a WebSocket upgrade resolved for itself.
 * @returns The resolved identity, or `undefined`.
 */
export function getRequestAgentIdentity(res: Pick<Response, 'locals'>): AgentIdentity | undefined {
  return res.locals.agentIdentity as AgentIdentity | undefined;
}

/**
 * Resolve `X-DorkOS-Agent` from a set of request headers.
 *
 * Split out of the middleware because a WebSocket upgrade needs the identical
 * answer and has no Express request to hand it: an upgrade arrives on the HTTP
 * server's `upgrade` event, so no middleware runs for it (see
 * `services/core/streams/stream-upgrade-auth.ts`). One implementation rather than
 * two keeps "which token resolves to which agent" a single fact.
 *
 * Never rejects and never throws — identity is attribution, not authorization
 * (spec `agent-trust` §3.1). Costs nothing when the header is absent, which is
 * the overwhelmingly common case.
 *
 * @param headers - The request or upgrade headers.
 * @param context - Where this was read, for the debug line on an unresolvable
 *   token.
 * @returns The resolved identity, or `undefined`.
 */
export async function resolveAgentIdentityFromHeaders(
  headers: Request['headers'],
  context = 'upgrade'
): Promise<AgentIdentity | undefined> {
  const header = headers[AGENT_IDENTITY_HEADER];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) return undefined;

  const service = getAgentIdentityService();
  if (!service) return undefined;

  try {
    const trimmed = token.trim();
    const identity = await service.resolve(trimmed);
    if (identity) return identity;
    // A token that goes nowhere is worth seeing: it is what a revoked or
    // expired agent looks like from the operator's side, and without a line
    // here that agent silently degrades to "unattributed" forever. The digest
    // prefix makes repeat attempts by the SAME token recognizable; the token
    // itself is never logged.
    logger.debug('[agent-identity] Presented token did not resolve', {
      tokenDigestPrefix: agentTokenDigestPrefix(trimmed),
      path: context,
    });
  } catch (err) {
    // A resolution failure must never take the request down with it — the
    // caller simply stays unattributed. Never log the presented token.
    logger.debug('[agent-identity] Token resolution failed', { err: String(err) });
  }
  return undefined;
}

/**
 * Express middleware that resolves `X-DorkOS-Agent` onto the request context.
 *
 * @param req - The incoming request.
 * @param res - The response whose `locals` receives the identity.
 * @param next - The next middleware in the stack.
 */
export async function resolveAgentIdentity(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const identity = await resolveAgentIdentityFromHeaders(req.headers, req.path);
  if (identity) res.locals.agentIdentity = identity;
  next();
}
