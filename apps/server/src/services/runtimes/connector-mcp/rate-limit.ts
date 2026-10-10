/** Independent rate limiter for the connector-only runtime MCP listener. */
import { expressRateLimit } from '../../../http/rate-limiter.js';
import type { RequestHandler } from 'express';

/** Listener-owned rate limit settings. */
export interface ConnectorRuntimeRateLimitOptions {
  /** Maximum requests accepted from one loopback peer per window. */
  readonly maxPerWindow?: number;
  /** Window duration in milliseconds. */
  readonly windowMs?: number;
}

/**
 * Build a limiter independent of the external MCP configuration.
 *
 * @param options - Optional test or deployment overrides.
 * @returns Express rate-limit middleware.
 */
export function buildConnectorRuntimeRateLimiter(
  options: ConnectorRuntimeRateLimitOptions = {}
): RequestHandler {
  return expressRateLimit({
    windowMs: options.windowMs ?? 60_000,
    limit: options.maxPerWindow ?? 120,
    headers: 'standard',
    message: {
      jsonrpc: '2.0',
      error: { code: -32029, message: 'Rate limit exceeded. Try again shortly.' },
      id: null,
    },
  });
}
