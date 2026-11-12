import type { MiddlewareHandler } from 'hono';
import { honoRateLimit } from '../http/rate-limiter.js';
import { honoRequestFacts, type RequestFactsEnv } from '../http/request-facts.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { AUTH_REQUIRED_BODY } from '../services/core/auth/session-gate.js';

/**
 * Throttle remote MCP credential guesses before either credential verifier runs.
 * Ten failures from one source spend a fifteen-minute sliding window; successful
 * requests return their reservation. The bounded shared limiter normalizes
 * addresses and trusts forwarding headers only when explicitly configured.
 *
 * The same flat 401 answers a bad, missing or throttled credential, with no
 * quota headers revealing which refusal occurred. Local tool traffic and other
 * paths keep their existing auth and rate limits. This limit cannot be switched
 * off with the post-auth MCP traffic limiter.
 */
export function buildMcpAuthThrottle(): MiddlewareHandler<RequestFactsEnv> {
  const skip = (c: Parameters<MiddlewareHandler<RequestFactsEnv>>[0]): boolean => {
    if (c.req.path !== '/mcp' && c.req.path !== '/mcp/') return true;
    const caller = classifyRequest(honoRequestFacts(c), currentServerRole());
    return caller.route === 'local';
  };
  const limiter = honoRateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    headers: 'none',
    message: AUTH_REQUIRED_BODY,
    skip,
    countsWhen: (c) => c.res.status === 401,
    onLimited: (c) => c.json(AUTH_REQUIRED_BODY, 401),
  });
  return async (c, next) => {
    if (skip(c)) return next();
    const response = await limiter(c, next);
    if (response) c.res = response;
    // The session gate and the MCP gate otherwise send different 401 bodies.
    if (c.res.status === 401) c.res = c.json(AUTH_REQUIRED_BODY, 401);
  };
}
