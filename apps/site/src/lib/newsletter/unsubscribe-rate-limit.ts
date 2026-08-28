/**
 * Per-IP throttles for `/api/newsletter/unsubscribe` (DOR-1586).
 *
 * **Two verbs, two buckets** — and the split is the point of this module.
 *
 * The verbs look like one operation on one resource, which argues for one
 * shared allowance. What breaks that argument is who sends each one, and what
 * it costs when each one is refused.
 *
 * - **GET** is the in-email link. It is in *every* broadcast, so it is the most
 *   pre-fetched URL this site has: email security scanners (Outlook Safe Links,
 *   Proofpoint) fetch links on delivery, from a corporate gateway address
 *   shared by everyone at that organization. One gateway serving a few dozen
 *   subscribers can spend a whole allowance in seconds, through no fault of any
 *   reader. Refusing one of these shows a person a page telling them to try
 *   again — annoying, and recoverable.
 * - **POST** is the RFC 8058 one-click, sent by the mail provider's own servers
 *   when a reader hits "unsubscribe" in Gmail or Apple Mail. Those also arrive
 *   from a handful of shared egress addresses, in a burst right after a send.
 *   Refusing one is **not** recoverable: the reader is told they unsubscribed,
 *   stays subscribed, keeps getting mail, and reports it as spam.
 *
 * Sharing one bucket would let the cheap, heavily pre-fetched failure starve the
 * expensive, silent one — a scanner sweep spending the allowance the next real
 * one-click needed. So each verb gets its own limiter instance, and one-click
 * gets the larger of the two.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window` for what that
 * does and does not buy.
 *
 * @module lib/newsletter/unsubscribe-rate-limit
 */
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/** In-email link opens one IP may spend per window (see module doc). */
export const UNSUBSCRIBE_LINK_RATE_LIMIT = 60;

/**
 * One-click unsubscribes one IP may spend per window. Twice the link
 * allowance: these arrive from mail-provider egress addresses shared by every
 * reader on that provider, and a refusal here fails silently.
 */
export const UNSUBSCRIBE_ONE_CLICK_RATE_LIMIT = 120;

/** Window length: ten minutes, matching the newsletter subscribe throttle. */
export const UNSUBSCRIBE_RATE_WINDOW_MS = 10 * 60 * 1000;

const linkLimiter = createPerIpLimiter({
  limit: UNSUBSCRIBE_LINK_RATE_LIMIT,
  windowMs: UNSUBSCRIBE_RATE_WINDOW_MS,
});

const oneClickLimiter = createPerIpLimiter({
  limit: UNSUBSCRIBE_ONE_CLICK_RATE_LIMIT,
  windowMs: UNSUBSCRIBE_RATE_WINDOW_MS,
});

/**
 * Spend one in-email link open (the `GET`) for the request's client IP.
 *
 * @param request - The incoming unsubscribe request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeUnsubscribeLinkQuota(request: Request, now?: number): RateLimitDecision {
  return linkLimiter.consume(request, now);
}

/**
 * Spend one RFC 8058 one-click unsubscribe (the `POST`) for the request's
 * client IP. Deliberately a separate bucket from the link above.
 *
 * @param request - The incoming unsubscribe request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeUnsubscribeOneClickQuota(request: Request, now?: number): RateLimitDecision {
  return oneClickLimiter.consume(request, now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetUnsubscribeRateLimit(): void {
  linkLimiter.reset();
  oneClickLimiter.reset();
}
