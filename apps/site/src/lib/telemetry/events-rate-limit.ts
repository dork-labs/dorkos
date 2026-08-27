/**
 * Per-IP throttle for `POST /api/telemetry/events` (DOR-1586).
 *
 * This sink stores nothing, but it does forward everything it accepts to
 * PostHog, so an unthrottled flood spends the project's ingest quota and the
 * site's function budget on somebody else's traffic.
 *
 * **The loosest allowance of any throttled route, because this is the chattiest
 * caller.** Each running DorkOS flushes about once a minute, and the usage,
 * error, and AI-metadata reporters all share the endpoint — so a single machine
 * can be ten posts per ten minutes on its own, and twenty machines behind one
 * office NAT are two hundred. Six hundred sits comfortably above that. A
 * refused batch is not retried (the reporters drop rather than re-queue, to
 * avoid an unbounded backlog), so anything this rejects is analytics lost for
 * good — which is the reason to be generous, not the reason to skip the limit.
 *
 * ## Privacy
 *
 * The client IP is read into a process-local counter and nothing else: never
 * stored, never logged, and never forwarded to PostHog. `distinct_id` stays the
 * payload's own anonymous `distinctId`.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window`. On the Edge
 * runtime state is per V8 isolate rather than per lambda, so this is friction,
 * not a hard cap; friction is all this layer ever claimed to be.
 *
 * @module lib/telemetry/events-rate-limit
 */
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/** Event batches one IP may post per window (see module doc). */
export const EVENTS_TELEMETRY_RATE_LIMIT = 600;

/** Window length: ten minutes, matching the other public-route throttles. */
export const EVENTS_TELEMETRY_RATE_WINDOW_MS = 10 * 60 * 1000;

const limiter = createPerIpLimiter({
  limit: EVENTS_TELEMETRY_RATE_LIMIT,
  windowMs: EVENTS_TELEMETRY_RATE_WINDOW_MS,
});

/**
 * Spend one event batch for the request's client IP. One batch counts once
 * however many events it carries — the route already caps a batch at 100.
 *
 * @param request - The incoming events request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeEventsTelemetryQuota(request: Request, now?: number): RateLimitDecision {
  return limiter.consume(request, now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetEventsTelemetryRateLimit(): void {
  limiter.reset();
}
