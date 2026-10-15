import type { MiddlewareHandler } from 'hono';
import { honoRateLimit } from '../http/rate-limiter.js';
import type { RequestFactsEnv } from '../http/request-facts.js';
import { configManager } from '../services/core/config-manager.js';

/**
 * Build a rate limiter for the external MCP endpoint from current config values.
 *
 * Called once, when the `/mcp` routes are built (`routes/mcp.ts`). Rate limit config changes
 * take effect after a server restart (the Settings UI communicates this).
 *
 * When rate limiting is disabled in config, returns a pass-through middleware.
 *
 * Keys through `rateLimitKey`, through {@link honoRateLimit} — the TCP peer address unless
 * `DORKOS_TRUST_PROXY` says a proxy is in front (DOR-1711). `/mcp` is the
 * surface most likely to be reached from off this machine, and it inherited
 * `req.ip`, so a caller sending a fresh `X-Forwarded-For` per request was never
 * counted.
 */
export function buildMcpRateLimiter(): MiddlewareHandler<RequestFactsEnv> {
  const cfg = configManager.get('mcp')?.rateLimit ?? {
    enabled: true,
    maxPerWindow: 60,
    windowSecs: 60,
  };

  if (!cfg.enabled) {
    return (_c, next) => next();
  }

  return honoRateLimit({
    windowMs: cfg.windowSecs * 1000,
    limit: cfg.maxPerWindow,
    headers: 'standard',
    message: {
      jsonrpc: '2.0',
      error: { code: -32029, message: 'Rate limit exceeded. Try again shortly.' },
      id: null,
    },
  });
}
