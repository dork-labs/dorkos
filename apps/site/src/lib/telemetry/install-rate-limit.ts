/**
 * Per-IP throttle for `POST /api/telemetry/install` (DOR-1586).
 *
 * Install counts rank the public marketplace, so an unthrottled sink is a
 * ranking-inflation vector: one `curl` loop can mint arbitrarily many `success`
 * rows for a package it wants featured.
 *
 * **Set loose on purpose — a false rejection here corrupts the same data the
 * throttle protects.** Legitimate installs share IPs constantly: an office
 * behind one NAT, a CI matrix, a shared VPN egress. Twenty developers each
 * installing a couple of packages in the same ten minutes is an ordinary
 * afternoon, and every event this refuses is an install that silently never
 * gets counted. A hundred and twenty is far above that and still turns an
 * unbounded flood into a bounded one.
 *
 * ## Privacy
 *
 * This is the only part of the install pipeline that touches a request header.
 * The client IP is read into a process-local counter and nothing else: it is
 * never written to `marketplace_install_events` (there is no column for it and
 * never will be), never logged, and never forwarded. The storage contract in
 * `contributing/marketplace-telemetry.md` §7 is unchanged, and its three tests
 * still hold.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window` for what that
 * does and does not buy. On the Edge runtime it buys less than on Node, because
 * state is per V8 isolate rather than per lambda; it is still friction, which is
 * all this layer ever claimed to be.
 *
 * @module lib/telemetry/install-rate-limit
 */
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/** Install events one IP may report per window (see module doc). */
export const INSTALL_TELEMETRY_RATE_LIMIT = 120;

/** Window length: ten minutes, matching the other public-route throttles. */
export const INSTALL_TELEMETRY_RATE_WINDOW_MS = 10 * 60 * 1000;

const limiter = createPerIpLimiter({
  limit: INSTALL_TELEMETRY_RATE_LIMIT,
  windowMs: INSTALL_TELEMETRY_RATE_WINDOW_MS,
});

/**
 * Spend one install event for the request's client IP.
 *
 * @param request - The incoming telemetry request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeInstallTelemetryQuota(request: Request, now?: number): RateLimitDecision {
  return limiter.consume(request, now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetInstallTelemetryRateLimit(): void {
  limiter.reset();
}
