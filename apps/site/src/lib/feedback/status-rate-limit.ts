/**
 * Per-IP throttle for `GET /api/feedback/[id]` (DOR-1586).
 *
 * Public and unauthenticated: the row id is an unguessable random uuid, and
 * knowing it is the access control. As with every token-gated route here, the
 * gate decides what a caller may see and the throttle decides what a caller may
 * cost — one indexed row read per guess, unbounded without this.
 *
 * The loosest of the two feedback reads, because it is the cheaper one: it
 * returns four fields and never the reporter's message, and it is reached from
 * a link in a receipt email, so email security scanners pre-fetch it from
 * corporate gateway addresses before the human clicks. The `/feedback/[id]`
 * page beside the route reads the database directly rather than calling this,
 * so a person opening the page never spends this allowance at all.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window` for what that
 * does and does not buy.
 *
 * @module lib/feedback/status-rate-limit
 */
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/** Status lookups one IP may spend per window (see module doc). */
export const FEEDBACK_STATUS_RATE_LIMIT = 120;

/** Window length: ten minutes, matching the other public-route throttles. */
export const FEEDBACK_STATUS_RATE_WINDOW_MS = 10 * 60 * 1000;

const limiter = createPerIpLimiter({
  limit: FEEDBACK_STATUS_RATE_LIMIT,
  windowMs: FEEDBACK_STATUS_RATE_WINDOW_MS,
});

/**
 * Spend one status lookup for the request's client IP.
 *
 * @param request - The incoming status request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeFeedbackStatusQuota(request: Request, now?: number): RateLimitDecision {
  return limiter.consume(request, now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetFeedbackStatusRateLimit(): void {
  limiter.reset();
}
