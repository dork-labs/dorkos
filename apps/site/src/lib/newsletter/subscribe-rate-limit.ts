/**
 * Per-IP throttle for `POST /api/newsletter/subscribe` (DOR-1581).
 *
 * The subscribe endpoint is public, unauthenticated, and reachable from the
 * two busiest boxes on the site (the footer and the tutorials modal), so a
 * `curl` loop could otherwise pump the pending list. The honeypot only catches
 * bots that fill hidden fields; this catches the plain flood.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window` for what that
 * does and does not buy.
 *
 * @module lib/newsletter/subscribe-rate-limit
 */
import { clientIpFromHeaders } from '@/lib/rate-limit/client-ip';
import { createFixedWindowLimiter } from '@/lib/rate-limit/fixed-window';
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';

/**
 * Subscribe attempts one IP may spend per window. A real person subscribes
 * once; five leaves room for a typo, a retry, and a household or office
 * sharing one address, while still capping a scripted flood at 30/hour.
 */
export const SUBSCRIBE_RATE_LIMIT = 5;

/** Window length: ten minutes. */
export const SUBSCRIBE_RATE_WINDOW_MS = 10 * 60 * 1000;

const limiter = createFixedWindowLimiter({
  limit: SUBSCRIBE_RATE_LIMIT,
  windowMs: SUBSCRIBE_RATE_WINDOW_MS,
});

/**
 * Spend one subscribe attempt for the request's client IP.
 *
 * Every POST counts, valid or not: an abuser posting garbage is exactly the
 * traffic this exists to slow, and the endpoint answers `200` for almost
 * everything, so the response code cannot decide what to charge for.
 *
 * @param request - The incoming subscribe request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeSubscribeQuota(request: Request, now?: number): RateLimitDecision {
  return limiter.consume(clientIpFromHeaders(request.headers), now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetSubscribeRateLimit(): void {
  limiter.reset();
}
