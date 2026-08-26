/**
 * In-memory, per-key fixed-window rate limiting for the site's public API
 * routes (DOR-1581).
 *
 * Deliberately dependency-free and process-local. The site runs as Vercel
 * serverless functions, so this state lives in one lambda instance's memory:
 * the limit is **per instance, not global**, and it resets on a cold start.
 * That is accepted on purpose — it is naive-abuse friction (one attacker, one
 * `curl` loop), not a security control. A globally exact limit would need a
 * shared KV/Redis store, which the site does not have and which this ticket
 * does not add.
 *
 * Time is a parameter, never a hidden read, so callers and tests drive the
 * clock.
 *
 * @module lib/rate-limit/fixed-window
 */

/** Outcome of one rate-limit check. */
export interface RateLimitDecision {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Whole seconds until this key's window resets. `0` when allowed. */
  retryAfterSeconds: number;
}

/** Settings for {@link createFixedWindowLimiter}. */
export interface FixedWindowLimiterOptions {
  /** Requests one key may spend per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Cap on simultaneously tracked keys. Defaults to 10,000. */
  maxKeys?: number;
}

/** A keyed fixed-window limiter. */
export interface FixedWindowLimiter {
  /**
   * Spend one request against `key` and decide whether it may proceed.
   *
   * @param key - Bucket identity, e.g. a client IP.
   * @param now - Current epoch milliseconds. Defaults to `Date.now()`.
   */
  consume: (key: string, now?: number) => RateLimitDecision;
  /** Forget every tracked window. */
  reset: () => void;
  /** How many keys are currently tracked. */
  size: () => number;
}

/**
 * Ceiling on tracked keys. A warm lambda would otherwise accumulate one Map
 * entry per distinct IP forever, which is a slow leak; expired entries are
 * pruned at this threshold and, if every window is still live, the oldest are
 * evicted.
 */
const DEFAULT_MAX_KEYS = 10_000;

interface Window {
  /** Epoch ms when this window opened. */
  start: number;
  /** Requests seen inside it. */
  count: number;
}

/**
 * Create a fixed-window limiter.
 *
 * Fixed window, not sliding: a key may spend its whole allowance at the end of
 * one window and again at the start of the next, so a determined caller can see
 * up to `2 × limit` across a window boundary. Accepted — the goal is friction,
 * and the simpler shape is the one worth trusting.
 *
 * @param options - Limit, window length, and optional key cap.
 * @returns A limiter holding its own private state.
 */
export function createFixedWindowLimiter({
  limit,
  windowMs,
  maxKeys = DEFAULT_MAX_KEYS,
}: FixedWindowLimiterOptions): FixedWindowLimiter {
  const windows = new Map<string, Window>();

  /** Drop expired windows, then the oldest live ones, until a slot is free. */
  function makeRoom(now: number): void {
    for (const [key, window] of windows) {
      if (now - window.start >= windowMs) windows.delete(key);
    }
    if (windows.size < maxKeys) return;
    const oldestFirst = [...windows.entries()].sort((a, b) => a[1].start - b[1].start);
    const excess = windows.size - maxKeys + 1;
    for (const [key] of oldestFirst.slice(0, excess)) windows.delete(key);
  }

  return {
    consume(key: string, now: number = Date.now()): RateLimitDecision {
      const current = windows.get(key);

      if (!current || now - current.start >= windowMs) {
        if (!current && windows.size >= maxKeys) makeRoom(now);
        windows.set(key, { start: now, count: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      current.count += 1;
      if (current.count <= limit) return { allowed: true, retryAfterSeconds: 0 };

      // Rounded up: the window is provably still open on this path, so a
      // sub-second remainder must still be reported as one second to wait.
      const remainingMs = current.start + windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
    },
    reset(): void {
      windows.clear();
    },
    size(): number {
      return windows.size;
    },
  };
}
