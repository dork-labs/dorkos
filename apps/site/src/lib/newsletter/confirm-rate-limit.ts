/**
 * Per-IP throttle for `GET /api/newsletter/confirm` (DOR-1586).
 *
 * The token already gates what this route can *do* — an unknown token confirms
 * nothing. The throttle is for the traffic a token cannot bound: a loop
 * guessing tokens, each guess costing a database read and a hash.
 *
 * The allowance is set by who legitimately arrives here. A subscriber follows
 * exactly one confirmation link, from their own browser. The bulk case is an
 * email security scanner (Outlook Safe Links, Proofpoint) pre-fetching the link
 * from a corporate gateway IP before the human clicks it — but confirmations
 * are sent one at a time, on subscribe, never broadcast, so even a large org
 * has only a handful in flight at once. Thirty is generous against that and
 * still leaves token-guessing hopeless.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window` for what that
 * does and does not buy.
 *
 * @module lib/newsletter/confirm-rate-limit
 */
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/** Confirm attempts one IP may spend per window (see module doc). */
export const CONFIRM_RATE_LIMIT = 30;

/** Window length: ten minutes, matching the newsletter subscribe throttle. */
export const CONFIRM_RATE_WINDOW_MS = 10 * 60 * 1000;

const limiter = createPerIpLimiter({
  limit: CONFIRM_RATE_LIMIT,
  windowMs: CONFIRM_RATE_WINDOW_MS,
});

/**
 * Spend one confirm attempt for the request's client IP.
 *
 * @param request - The incoming confirm request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeConfirmQuota(request: Request, now?: number): RateLimitDecision {
  return limiter.consume(request, now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetConfirmRateLimit(): void {
  limiter.reset();
}
