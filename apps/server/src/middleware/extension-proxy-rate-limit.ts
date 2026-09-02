import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

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
 * SECURITY: the per-IP buckets hold only behind a single trusted proxy —
 * `app.ts` sets `trust proxy, 1`, so the client IP comes from
 * `X-Forwarded-For`. On a direct public bind a caller can rotate spoofed values
 * across unlimited buckets, exactly as `a2a-rate-limit` documents. Treat this
 * as a throttle, not an authorization boundary.
 *
 * @param maxPerMinute - Requests per minute per IP; defaults to
 *   {@link EXTENSION_PROXY_RATE_LIMIT_DEFAULT}.
 */
export function buildExtensionProxyRateLimiter(maxPerMinute?: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: maxPerMinute ?? EXTENSION_PROXY_RATE_LIMIT_DEFAULT,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many requests to this extension proxy. Try again shortly.',
      code: 'PROXY_RATE_LIMITED',
    },
  });
}
