/**
 * Per-IP throttle for `/api/newsletter/unsubscribe` (DOR-1586).
 *
 * Both verbs share one allowance: they are the same idempotent operation on the
 * same token, so counting them separately would only invent a second bucket for
 * one resource.
 *
 * **The RFC 8058 one-click POST is what sets the number, and it is set loose on
 * purpose.** A GET arrives from the subscriber's own browser, so those requests
 * spread across as many IPs as there are readers. A one-click POST does not: the
 * mail provider's servers make it, so every Gmail reader who unsubscribes from
 * one broadcast arrives from the same handful of Google egress addresses, in a
 * burst, right after the send. Throttling that would fail the unsubscribe
 * silently — the reader sees "unsubscribed", keeps getting mail, and reports it
 * as spam. A refused unsubscribe costs far more than an extra token read, so
 * sixty per ten minutes sits well above any realistic provider burst while
 * still capping a `curl` loop that is guessing tokens.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window` for what that
 * does and does not buy.
 *
 * @module lib/newsletter/unsubscribe-rate-limit
 */
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/** Unsubscribe attempts one IP may spend per window (see module doc). */
export const UNSUBSCRIBE_RATE_LIMIT = 60;

/** Window length: ten minutes, matching the newsletter subscribe throttle. */
export const UNSUBSCRIBE_RATE_WINDOW_MS = 10 * 60 * 1000;

const limiter = createPerIpLimiter({
  limit: UNSUBSCRIBE_RATE_LIMIT,
  windowMs: UNSUBSCRIBE_RATE_WINDOW_MS,
});

/**
 * Spend one unsubscribe attempt for the request's client IP. Shared by the
 * human-clicked `GET` and the one-click `POST`.
 *
 * @param request - The incoming unsubscribe request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeUnsubscribeQuota(request: Request, now?: number): RateLimitDecision {
  return limiter.consume(request, now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetUnsubscribeRateLimit(): void {
  limiter.reset();
}
