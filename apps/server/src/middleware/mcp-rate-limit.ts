import type { Request, Response, NextFunction } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { rateLimitKey } from './rate-limit-key.js';
import { configManager } from '../services/core/config-manager.js';

/**
 * Build a rate limiter for the external MCP endpoint from current config values.
 *
 * Called once at server startup in index.ts. Rate limit config changes
 * take effect after a server restart (the Settings UI communicates this).
 *
 * When rate limiting is disabled in config, returns a pass-through middleware.
 *
 * Keys through {@link rateLimitKey} — the TCP peer address unless
 * `DORKOS_TRUST_PROXY` says a proxy is in front (DOR-1711). `/mcp` is the
 * surface most likely to be reached from off this machine, and it inherited
 * `req.ip`, so a caller sending a fresh `X-Forwarded-For` per request was never
 * counted.
 */
export function buildMcpRateLimiter(): RateLimitRequestHandler {
  const cfg = configManager.get('mcp')?.rateLimit ?? {
    enabled: true,
    maxPerWindow: 60,
    windowSecs: 60,
  };

  if (!cfg.enabled) {
    return ((_req: Request, _res: Response, next: NextFunction) =>
      next()) as unknown as RateLimitRequestHandler;
  }

  return rateLimit({
    windowMs: cfg.windowSecs * 1000,
    max: cfg.maxPerWindow,
    keyGenerator: rateLimitKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      jsonrpc: '2.0',
      error: { code: -32029, message: 'Rate limit exceeded. Try again shortly.' },
      id: null,
    },
  });
}
