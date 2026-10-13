import { factsRateLimit, type RateLimitVerdict } from '../http/rate-limiter.js';
import type { RequestFacts } from '../http/request-facts.js';

/** Default requests per minute per IP through one extension's data proxy. */
export const EXTENSION_PROXY_RATE_LIMIT_DEFAULT = 120;

/** Rate-limit window: one minute. */
const WINDOW_MS = 60_000;

/** The refusal body, sent with status 429. */
export const EXTENSION_PROXY_RATE_LIMITED_BODY = {
  error: 'Too many requests to this extension proxy. Try again shortly.',
  code: 'PROXY_RATE_LIMITED',
} as const;

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
 * One limiter is built per proxy, so each extension gets its own budget and a
 * chatty one cannot starve the rest.
 *
 * Keys through `rateLimitKey`, through {@link factsRateLimit} — the TCP peer address unless
 * `DORKOS_TRUST_PROXY` says a proxy is in front (DOR-1711), so a caller can no
 * longer rotate a spoofed `X-Forwarded-For` across unlimited buckets. It is
 * still a throttle rather than an authorization boundary: what stops an
 * unapproved caller is the extension approval gate, not this.
 *
 * @param maxPerMinute - Requests per minute per IP; defaults to
 *   {@link EXTENSION_PROXY_RATE_LIMIT_DEFAULT}.
 * @returns Count one request from the caller these facts describe.
 */
export function buildExtensionProxyRateLimiter(
  maxPerMinute?: number
): (caller: RequestFacts) => RateLimitVerdict {
  return factsRateLimit({
    windowMs: WINDOW_MS,
    limit: maxPerMinute ?? EXTENSION_PROXY_RATE_LIMIT_DEFAULT,
    headers: 'standard',
  });
}
