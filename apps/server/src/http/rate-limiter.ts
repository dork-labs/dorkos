/**
 * The server's one rate limiter: a bounded in-process sliding window, with a
 * thin adapter for each chain (DOR-2796).
 *
 * It replaces `express-rate-limit`, so its answers keep that package's shape:
 * the IETF draft-6 `RateLimit-*` headers (or the legacy `X-RateLimit-*` ones
 * where a limiter used them), `Retry-After` on a refusal, status 429 and each
 * limiter's own refusal body. Every limiter keys through `rateLimitKey`, so a
 * caller is one bucket whichever chain counts it.
 *
 * ## Sliding, not fixed
 *
 * `express-rate-limit` counted in a fixed window that began at a client's first
 * request, so a client could spend a whole budget at the end of one window and
 * another at the start of the next. This keeps each counted request's time and
 * refuses while `limit` of them fall inside the last `windowMs`, so no stretch
 * of `windowMs` ever admits more than `limit`. A refused request is not
 * recorded: a caller that keeps knocking waits out the window, never longer.
 *
 * ## Bounded, and closed when full
 *
 * At most `maxKeys` buckets are held, each with at most `limit` times. When the
 * table is full, buckets with nothing left in their window are dropped. If
 * every bucket is still live, a NEW caller is refused rather than a live bucket
 * dropped: dropping one would hand back the budget of whoever owned it, and a
 * guesser rotating through more addresses than the table holds would never be
 * limited at all. `express-rate-limit` had no bound and no such refusal; with
 * keys that are an IPv4 address or an IPv6 /56, filling the default 100,000
 * buckets inside one window takes an attack, and refusing newcomers during one
 * is the answer that fails closed. Callers already in the table are unaffected.
 *
 * @module http/rate-limiter
 */
import type { NextFunction, Request, RequestHandler, Response as ExpressResponse } from 'express';
import type { Context, MiddlewareHandler } from 'hono';
import { expressRequestFacts, honoRequestFacts, type RequestFactsEnv } from './request-facts.js';
import { rateLimitKey } from '../middleware/rate-limit-key.js';

/** How much a limiter allows. */
export interface RateLimitPolicy {
  /** The window, in milliseconds. */
  readonly windowMs: number;
  /** Requests allowed in any one window. */
  readonly limit: number;
  /** Most buckets held at once. Defaults to 10,000. */
  readonly maxKeys?: number;
}

/** One counted (or refused) request. */
export interface RateLimitDecision {
  /** Whether the request may go on. */
  readonly allowed: boolean;
  /** The limit it was counted against. */
  readonly limit: number;
  /** Requests left in the window after this one. */
  readonly remaining: number;
  /** When the oldest counted request leaves the window, in epoch milliseconds. */
  readonly resetAt: number;
  /** Give this request's count back. Does nothing for a refused request. */
  refund(): void;
}

/** A limiter's state: count requests under a key. */
export interface RateLimiter {
  /** The policy this limiter enforces. */
  readonly policy: RateLimitPolicy;
  /**
   * Count one request under `key`, or refuse it once the window is full.
   *
   * @param key - The bucket, from `rateLimitKey`.
   * @param now - The current time, for tests.
   */
  hit(key: string, now?: number): RateLimitDecision;
}

const DEFAULT_MAX_KEYS = 100_000;

/** How long a sweep that freed nothing is trusted before the next one. */
const FULL_SWEEP_INTERVAL_MS = 1_000;

/**
 * Create one limiter. Each call is its own set of buckets.
 *
 * @param policy - The window, the limit and the bucket bound.
 * @returns The limiter.
 */
export function createRateLimiter(policy: RateLimitPolicy): RateLimiter {
  const maxKeys = policy.maxKeys ?? DEFAULT_MAX_KEYS;
  const buckets = new Map<string, number[]>();

  let sweptAt = Number.NEGATIVE_INFINITY;

  /** Whether a new bucket fits, after dropping the expired ones. */
  const roomForNew = (now: number): boolean => {
    if (buckets.size < maxKeys) return true;
    // Sweeping is linear in the table, so a full table of live buckets is not
    // re-swept on every newcomer.
    if (now - sweptAt < FULL_SWEEP_INTERVAL_MS) return false;
    sweptAt = now;
    for (const [key, times] of buckets) {
      if ((times.at(-1) ?? 0) <= now - policy.windowMs) buckets.delete(key);
    }
    return buckets.size < maxKeys;
  };

  return {
    policy,
    hit(key, now = Date.now()) {
      const known = buckets.get(key);
      const live = (known ?? []).filter((time) => time > now - policy.windowMs);
      const allowed = live.length < policy.limit && (known !== undefined || roomForNew(now));
      let recorded: number | undefined;
      if (allowed) {
        recorded = now;
        live.push(now);
      }
      if (live.length > 0) buckets.set(key, live);
      else buckets.delete(key);
      return {
        allowed,
        limit: policy.limit,
        remaining: Math.max(policy.limit - live.length, 0),
        resetAt: (live[0] ?? now) + policy.windowMs,
        refund() {
          if (recorded === undefined) return;
          const times = buckets.get(key);
          const index = times?.lastIndexOf(recorded) ?? -1;
          if (index !== -1) times!.splice(index, 1);
          if (times?.length === 0) buckets.delete(key);
          recorded = undefined;
        },
      };
    },
  };
}

/** Which headers a limiter answers with. */
export type RateLimitHeaders = 'standard' | 'legacy';

/** Seconds until `resetAt`, never negative. */
function secondsUntil(resetAt: number, now: number): number {
  return Math.max(0, Math.ceil((resetAt - now) / 1000));
}

/**
 * The headers for one decision, in `express-rate-limit`'s draft-6 or legacy
 * shape, plus `Retry-After` when it was refused.
 *
 * @param decision - The decision.
 * @param policy - The limiter's policy, for the window it names.
 * @param style - Which header family.
 * @param now - The current time.
 * @returns Header names and values to set.
 */
export function rateLimitHeaders(
  decision: RateLimitDecision,
  policy: RateLimitPolicy,
  style: RateLimitHeaders,
  now = Date.now()
): Record<string, string> {
  const reset = secondsUntil(decision.resetAt, now);
  const headers: Record<string, string> =
    style === 'standard'
      ? {
          'RateLimit-Policy': `${decision.limit};w=${Math.ceil(policy.windowMs / 1000)}`,
          'RateLimit-Limit': String(decision.limit),
          'RateLimit-Remaining': String(decision.remaining),
          'RateLimit-Reset': String(reset),
        }
      : {
          'X-RateLimit-Limit': String(decision.limit),
          'X-RateLimit-Remaining': String(decision.remaining),
          Date: new Date(now).toUTCString(),
          'X-RateLimit-Reset': String(Math.ceil(decision.resetAt / 1000)),
        };
  if (!decision.allowed) headers['Retry-After'] = String(reset);
  return headers;
}

/** What every limiter adapter needs besides the policy. */
interface RateLimitAnswer extends RateLimitPolicy {
  /** Which header family to answer with. */
  readonly headers: RateLimitHeaders;
  /** The JSON refusal body, sent with status 429. */
  readonly message: object;
}

/** Options for {@link expressRateLimit}. */
export interface ExpressRateLimitOptions extends RateLimitAnswer {
  /** Count nothing for this request. */
  readonly skip?: (req: Request) => boolean;
  /** Answer a refusal yourself instead of sending `message`. */
  readonly onLimited?: (req: Request, res: ExpressResponse) => void;
  /**
   * Give the count back once the response is done unless this holds, as for a
   * refusal that cost nothing. A response that closes before it ends is given
   * back too, as `express-rate-limit`'s `skipFailedRequests` did.
   */
  readonly countsWhen?: (req: Request, res: ExpressResponse) => boolean;
}

/**
 * The limiter as Express middleware, for the routes the Express chain still
 * mounts.
 *
 * @param options - The policy, headers, refusal and optional hooks.
 * @returns Express middleware.
 */
export function expressRateLimit(options: ExpressRateLimitOptions): RequestHandler {
  const limiter = createRateLimiter(options);
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    if (options.skip?.(req)) {
      next();
      return;
    }
    const now = Date.now();
    const decision = limiter.hit(rateLimitKey(expressRequestFacts(req)), now);
    if (!res.headersSent) res.set(rateLimitHeaders(decision, limiter.policy, options.headers, now));
    if (!decision.allowed) {
      if (options.onLimited) options.onLimited(req, res);
      else res.status(429).json(options.message);
      return;
    }
    const counts = options.countsWhen;
    if (counts) {
      res.once('finish', () => {
        if (!counts(req, res)) decision.refund();
      });
      res.once('close', () => {
        if (!res.writableEnded) decision.refund();
      });
    }
    next();
  };
}

/** Options for {@link honoRateLimit}. */
export interface HonoRateLimitOptions extends RateLimitAnswer {
  /** Count nothing for this request. */
  readonly skip?: (c: Context<RequestFactsEnv>) => boolean;
  /** Answer a refusal yourself instead of sending `message`. */
  readonly onLimited?: (c: Context<RequestFactsEnv>) => Response | Promise<Response>;
  /**
   * Give the count back once the handler has answered unless this holds. Unlike
   * the Express adapter, a client that hangs up mid-response is not given back.
   */
  readonly countsWhen?: (c: Context<RequestFactsEnv>) => boolean;
}

/**
 * The limiter as Hono middleware, for routes the Hono chain serves.
 *
 * @param options - The policy, headers, refusal and optional hooks.
 * @returns Hono middleware.
 */
export function honoRateLimit(options: HonoRateLimitOptions): MiddlewareHandler<RequestFactsEnv> {
  const limiter = createRateLimiter(options);
  return async (c, next) => {
    if (options.skip?.(c)) {
      await next();
      return;
    }
    const now = Date.now();
    const decision = limiter.hit(rateLimitKey(honoRequestFacts(c)), now);
    const headers = rateLimitHeaders(decision, limiter.policy, options.headers, now);
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    if (!decision.allowed) {
      if (options.onLimited) return options.onLimited(c);
      // The same bytes and type Express's `res.json` sends.
      return c.body(JSON.stringify(options.message), 429, {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    await next();
    // A handler that returns its own `Response` replaces the one `c.header`
    // wrote to; set them again on whatever is going out.
    for (const [name, value] of Object.entries(headers)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
    if (options.countsWhen && !options.countsWhen(c)) decision.refund();
  };
}
