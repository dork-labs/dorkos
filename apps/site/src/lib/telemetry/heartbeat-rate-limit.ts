/**
 * Per-IP throttle for `POST /api/telemetry/heartbeat` (DOR-1586).
 *
 * The heartbeat route's own module doc names the hole this fills: the upsert
 * keys on `instanceId`, so a real installation only ever owns one row, but a
 * spray of random valid UUIDs still mints one row per UUID and inflates the
 * distinct-instance metric. That doc concluded a per-IP limit was unavailable
 * without a KV or Redis store the telemetry architecture forbids. DOR-1581's
 * process-local limiter is the answer that adds neither: no new dependency, no
 * new secret, no new infrastructure.
 *
 * Allowance: an installation heartbeats once a day plus once on boot, so the
 * realistic burst is an office coming online — a few dozen machines behind one
 * NAT within a few minutes. Sixty clears that with room and still bounds a
 * spray that is otherwise unbounded.
 *
 * ## Privacy
 *
 * The client IP is read into a process-local counter and nothing else: never
 * written to `instance_heartbeats` (there is no column for it), never logged,
 * never forwarded. The payload contract is unchanged.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window`. On the Edge
 * runtime state is per V8 isolate rather than per lambda, so this is friction,
 * not a hard cap; friction is all this layer ever claimed to be.
 *
 * @module lib/telemetry/heartbeat-rate-limit
 */
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/** Heartbeats one IP may report per window (see module doc). */
export const HEARTBEAT_TELEMETRY_RATE_LIMIT = 60;

/** Window length: ten minutes, matching the other public-route throttles. */
export const HEARTBEAT_TELEMETRY_RATE_WINDOW_MS = 10 * 60 * 1000;

const limiter = createPerIpLimiter({
  limit: HEARTBEAT_TELEMETRY_RATE_LIMIT,
  windowMs: HEARTBEAT_TELEMETRY_RATE_WINDOW_MS,
});

/**
 * Spend one heartbeat for the request's client IP.
 *
 * @param request - The incoming heartbeat request.
 * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
 * @returns Whether the request may proceed, and when to retry if not.
 */
export function consumeHeartbeatTelemetryQuota(request: Request, now?: number): RateLimitDecision {
  return limiter.consume(request, now);
}

/** @internal Exported for testing only — clears every tracked window. */
export function resetHeartbeatTelemetryRateLimit(): void {
  limiter.reset();
}
