import type { MiddlewareHandler } from 'hono';
import { honoRateLimit } from '../http/rate-limiter.js';
import { honoRequestFacts, type RequestFactsEnv } from '../http/request-facts.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { AUTH_REQUIRED_BODY } from '../services/core/auth/session-gate.js';
import { MCP_KEY_REFUSAL_MESSAGE } from './mcp-auth.js';

/**
 * The one 401 a remote `/mcp` caller gets: the session gate's code, plus the
 * next step `/a2a` names (DOR-4264). The same body for a missing, bad or
 * throttled credential, so it still says nothing about which it was, and it
 * names no token and no path.
 */
export const MCP_REMOTE_AUTH_REQUIRED_BODY = {
  ...AUTH_REQUIRED_BODY,
  message: MCP_KEY_REFUSAL_MESSAGE,
} as const;

/**
 * Throttle remote MCP credential guesses before either credential verifier runs.
 * Ten failures from one source spend a fifteen-minute sliding window; successful
 * requests return their reservation. The bounded shared limiter normalizes
 * addresses. A source is the TCP peer, except through the own tunnel or managed
 * access, where it is the client ngrok's edge saw (`edgeClientRateLimitKey`).
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
    // Through the tunnel every caller has the loopback peer: key by the edge-observed client,
    // or one stranger's ten junk keys would lock the owner out too (DOR-4205).
    key: 'edge-client',
    message: MCP_REMOTE_AUTH_REQUIRED_BODY,
    skip,
    countsWhen: (c) => c.res.status === 401,
    onLimited: (c) => c.json(MCP_REMOTE_AUTH_REQUIRED_BODY, 401),
  });
  return async (c, next) => {
    if (skip(c)) return next();
    const response = await limiter(c, next);
    if (response) c.res = response;
    // The session gate and the MCP gate otherwise send different 401 bodies.
    if (c.res.status === 401) c.res = c.json(MCP_REMOTE_AUTH_REQUIRED_BODY, 401);
  };
}
