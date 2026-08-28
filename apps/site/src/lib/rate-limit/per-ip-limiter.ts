/**
 * Per-IP throttling for one public API route (DOR-1586).
 *
 * The two halves built in DOR-1581 — {@link clientIpFromHeaders} for naming the
 * caller and {@link createFixedWindowLimiter} for counting it — are always used
 * together, once per route. This composes them so a route's own rate-limit
 * module carries only the part that is actually route-specific: the policy
 * numbers and the reason for them.
 *
 * Each call creates an **independent** limiter with its own private Map, so one
 * route's flood can never spend another route's allowance. Give every throttled
 * route its own call; never share one instance across routes.
 *
 * Instance-local by design — see `lib/rate-limit/fixed-window` for what that
 * does and does not buy.
 *
 * @module lib/rate-limit/per-ip-limiter
 */
import { clientIpFromHeaders } from '@/lib/rate-limit/client-ip';
import { createFixedWindowLimiter } from '@/lib/rate-limit/fixed-window';
import type { RateLimitDecision } from '@/lib/rate-limit/fixed-window';

/** Settings for {@link createPerIpLimiter}. */
export interface PerIpLimiterOptions {
  /** Requests one client IP may spend per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** A request-keyed throttle for one route. */
export interface PerIpLimiter {
  /**
   * Spend one request against its client IP and decide whether it may proceed.
   *
   * @param request - The incoming request, read for its proxy headers only.
   * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
   */
  consume: (request: Request, now?: number) => RateLimitDecision;
  /** Forget every tracked window. */
  reset: () => void;
}

/**
 * Create one route's per-IP throttle.
 *
 * @param options - The route's policy: allowance and window length.
 * @returns A limiter holding its own private state.
 */
export function createPerIpLimiter({ limit, windowMs }: PerIpLimiterOptions): PerIpLimiter {
  const limiter = createFixedWindowLimiter({ limit, windowMs });

  return {
    consume(request: Request, now?: number): RateLimitDecision {
      return limiter.consume(clientIpFromHeaders(request.headers), now);
    },
    reset(): void {
      limiter.reset();
    },
  };
}
