/**
 * Per-IP throttle for `GET /api/feedback/mine` (DOR-1586).
 *
 * Public and unauthenticated: the `instanceId` query param is the access
 * control. That gates *what* a caller can see — it does not gate what a caller
 * can *cost*. Every guess is an indexed read that returns up to 200 rows
 * carrying the reporter's own message text, so a loop walking id space is the
 * most expensive read on the site and the only public one that returns
 * free-text content.
 *
 * Allowance: the app's "Product feedback" panel fetches through the local
 * server's proxy on mount and on window focus, so a person moving between
 * windows can produce a small burst from one address, and a household or office
 * shares that address. Sixty per ten minutes is far above any real panel and
 * still turns an unbounded walk into a bounded one.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window` for what that
 * does and does not buy.
 *
 * @module lib/feedback/history-rate-limit
 */
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/** History reads one IP may spend per window (see module doc). */
export const FEEDBACK_HISTORY_RATE_LIMIT = 60;

/** Window length: ten minutes, matching the other public-route throttles. */
export const FEEDBACK_HISTORY_RATE_WINDOW_MS = 10 * 60 * 1000;

const limiter = createPerIpLimiter({
  limit: FEEDBACK_HISTORY_RATE_LIMIT,
  windowMs: FEEDBACK_HISTORY_RATE_WINDOW_MS,
});

/**
 * Spend one history read for the request's client IP.
 *
 * @param request - The incoming list request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeFeedbackHistoryQuota(request: Request, now?: number): RateLimitDecision {
  return limiter.consume(request, now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetFeedbackHistoryRateLimit(): void {
  limiter.reset();
}
