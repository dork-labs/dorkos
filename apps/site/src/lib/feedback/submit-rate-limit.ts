/**
 * Per-IP throttle for `POST /api/feedback` (DOR-1586).
 *
 * The feedback intake is public and unauthenticated — the honeypot only catches
 * bots that fill hidden fields, so a plain `curl` loop could otherwise pump the
 * `feedback_submission` table. Each accepted submission is also the most
 * expensive request the site serves: a Neon insert, a receipt email, and a
 * Linear issue. That cost per request is what sets the allowance here, not just
 * the storage.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window` for what that
 * does and does not buy.
 *
 * @module lib/feedback/submit-rate-limit
 */
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/**
 * Submissions one IP may spend per window. A person files one report, or a few
 * in a row after a bad session; ten leaves room for that plus an office or
 * household behind one address, while capping a scripted flood at 60/hour —
 * and every one of those 60 would otherwise mint a Linear issue and an email.
 */
export const FEEDBACK_RATE_LIMIT = 10;

/** Window length: ten minutes, matching the newsletter subscribe throttle. */
export const FEEDBACK_RATE_WINDOW_MS = 10 * 60 * 1000;

const limiter = createPerIpLimiter({
  limit: FEEDBACK_RATE_LIMIT,
  windowMs: FEEDBACK_RATE_WINDOW_MS,
});

/**
 * Spend one feedback submission for the request's client IP.
 *
 * Every POST counts, valid or not: an abuser posting garbage is exactly the
 * traffic this exists to slow, and the endpoint answers `200` for a dropped
 * honeypot hit too, so the response code cannot decide what to charge for.
 *
 * @param request - The incoming feedback request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeFeedbackQuota(request: Request, now?: number): RateLimitDecision {
  return limiter.consume(request, now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetFeedbackRateLimit(): void {
  limiter.reset();
}
