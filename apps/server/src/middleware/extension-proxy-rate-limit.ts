import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { rateLimitKey } from './rate-limit-key.js';

/** Default requests per minute per IP through one extension's data proxy. */
export const EXTENSION_PROXY_RATE_LIMIT_DEFAULT = 120;

/** Rate-limit window: one minute. */
const WINDOW_MS = 60_000;

/**
 * Build the throttle for one extension's `dataProxy` route.
 *
 * Every request through that route reads the extension's stored secret and
 * makes an outbound call to a third-party API with the operator's credential
 * attached — a credential amplifier. Approving an extension to run is not the
 * same as approving unlimited traffic through it, so the route gets the same
 * kind of limiter the other credential-bearing surfaces have (`mcp-rate-limit`,
 * `a2a-rate-limit`, `auth-rate-limit`).
 *
 * One limiter is built per proxy router, so each extension gets its own budget
 * and a chatty one cannot starve the rest.
 *
 * Keys through {@link rateLimitKey} — the TCP peer address unless
 * `DORKOS_TRUST_PROXY` says a proxy is in front (DOR-1711), so a caller can no
 * longer rotate a spoofed `X-Forwarded-For` across unlimited buckets. It is
 * still a throttle rather than an authorization boundary: what stops an
 * unapproved caller is the extension approval gate, not this.
 *
 * @param maxPerMinute - Requests per minute per IP; defaults to
 *   {@link EXTENSION_PROXY_RATE_LIMIT_DEFAULT}.
 */
export function buildExtensionProxyRateLimiter(maxPerMinute?: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: maxPerMinute ?? EXTENSION_PROXY_RATE_LIMIT_DEFAULT,
    keyGenerator: rateLimitKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many requests to this extension proxy. Try again shortly.',
      code: 'PROXY_RATE_LIMITED',
    },
  });
}
