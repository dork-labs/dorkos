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
 * @param res - The Express response holding the request-scoped locals.
 * @returns The resolved identity, or `undefined`.
 */
export function getRequestAgentIdentity(res: Response): AgentIdentity | undefined {
  return res.locals.agentIdentity as AgentIdentity | undefined;
}

/**
 * Express middleware that resolves `X-DorkOS-Agent` onto the request context.
 *
 * Costs nothing when the header is absent (the overwhelmingly common case): no
 * database round-trip, no allocation beyond the header read.
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
  const header = req.headers[AGENT_IDENTITY_HEADER];
  const token = Array.isArray(header) ? header[0] : header;

  if (!token) {
    next();
    return;
  }

  const service = getAgentIdentityService();
  if (!service) {
    next();
    return;
  }

  try {
    const identity = await service.resolve(token.trim());
    if (identity) {
      res.locals.agentIdentity = identity;
    }
  } catch (err) {
    // A resolution failure must never take the request down with it — the
    // caller simply stays unattributed. Never log the presented token.
    logger.debug('[agent-identity] Token resolution failed', { err: String(err) });
  }

  next();
}
