import type { MiddlewareHandler } from 'hono';
import { recordSignInRateLimited } from '../services/core/auth/auth-audit.js';
import { honoRateLimit } from '../http/rate-limiter.js';
import type { RequestFactsEnv } from '../http/request-facts.js';

/**
 * Rate-limit window for credential attempts: 15 minutes.
 *
 * A long rolling window is what actually blunts brute-force. Better Auth's own
 * built-in throttle (see {@link buildAuthRateLimiter}) uses a 10-second window,
 * which resets fast enough to allow ~18 guesses/minute indefinitely; this outer
 * layer caps the sustained rate no matter how long an attacker keeps trying.
 */
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Default max credential attempts per IP per window (10), overridable via
 * `DORKOS_AUTH_SIGNIN_RATE_LIMIT` (see {@link AuthRateLimitOptions}).
 *
 * Chosen to blunt brute-force without locking out a legitimate user: 10 attempts
 * in 15 minutes leaves ample room for a person who fat-fingers their password a
 * few times and retries, while capping a guesser to ~40 attempts/hour (versus the
 * ~1000/hour Better Auth's 3-per-10s inner throttle alone would permit). The
 * strict admin limiter is 3/5min; sign-in is deliberately more lenient because a
 * mistyped password is a normal, expected event.
 */
const DEFAULT_MAX_ATTEMPTS = 10;

/** Options for {@link buildAuthRateLimiter}. Omitted values use the defaults. */
export interface AuthRateLimitOptions {
  /**
   * Max sign-in/sign-up attempts per IP per 15-minute window (default 10).
   * Wired from `DORKOS_AUTH_SIGNIN_RATE_LIMIT` in `index.ts` — a knob for a
   * dev/QA loop or a locked-out owner, mirroring the A2A rate-limit overrides.
   */
  maxAttempts?: number;
}

/**
 * Whether a request is a credential-guessing attempt worth counting.
 *
 * Matched against the two exact password endpoints Better Auth exposes for our
 * `emailAndPassword`-only config: `POST /api/auth/sign-in/email` and
 * `POST /api/auth/sign-up/email` (the `apiKey` plugin adds no unauthenticated
 * endpoints). Deliberately NOT a `/sign-in` prefix: that would also throttle a
 * future `/api/auth/sign-in/social` OAuth-initiation POST once the invites/OAuth
 * spec lands — an unrelated redirect handshake, not a password guess. Benign,
 * high-frequency `GET`s (e.g. the `/api/auth/get-session` check the client polls)
 * and every non-auth route pass through uncounted — the limiter must never
 * throttle normal app traffic. The path is lowercased as belt-and-suspenders; it
 * is not a correctness requirement (Better Auth's own router matches these paths
 * case-sensitively).
 *
 * @param method - The request method.
 * @param path - The full request path.
 * @returns `true` when the request is a password sign-in/sign-up POST to count.
 */
function isCredentialAttempt(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  const lowered = path.toLowerCase();
  return lowered === '/api/auth/sign-in/email' || lowered === '/api/auth/sign-up/email';
}

/** What a refused attempt is answered with. */
const RATE_LIMITED_BODY = {
  error: 'Too many sign-in attempts. Try again in a few minutes.',
  code: 'RATE_LIMITED',
};

/**
 * Build the app-level rate limiter for Better Auth's sign-in / sign-up endpoints.
 *
 * Defense-in-depth for local password brute-force (DOR-281). Mounted on the
 * Hono `/api` chain ahead of the Better Auth handler (`http/better-auth.ts`);
 * it counts only credential-guessing POSTs ({@link isCredentialAttempt}) and
 * skips everything else, so session-check GETs and non-auth routes are
 * untouched.
 *
 * This layers over — it does not replace — Better Auth's own built-in throttle.
 * Better Auth applies a special rule (window 10s, max 3) to `/sign-in`,
 * `/sign-up`, `/change-password`, and `/change-email`, but only when its
 * `rateLimit.enabled` resolves truthy, which defaults to `isProduction`. That
 * inner layer is therefore absent outside production and, even when present, its
 * short window permits a high sustained guess rate. This limiter is
 * environment-independent and window-based, closing both gaps.
 *
 * Keys through `rateLimitKey`, like every other limiter here: the TCP peer
 * address, which no header can move, unless `DORKOS_TRUST_PROXY` says a proxy is
 * in front. This limiter is why that changed (DOR-1711). It inherited `req.ip`
 * from the Express chain's `trust proxy, 1`, so `X-Forwarded-For` decided the
 * bucket — and
 * a password guesser sending a different value each attempt got a fresh budget
 * every time, which is to say no brake at all on the one surface where a brake
 * is the whole point.
 *
 * @param options - Per-limiter overrides (default: 10 attempts per window).
 * @returns Hono middleware returning a clean JSON `429`.
 */
export function buildAuthRateLimiter(
  options: AuthRateLimitOptions = {}
): MiddlewareHandler<RequestFactsEnv> {
  return honoRateLimit({
    windowMs: WINDOW_MS,
    limit: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    headers: 'standard',
    // Count only sign-in/sign-up POSTs; benign session-check GETs and every
    // non-auth route pass through without consuming the budget.
    skip: (c) => !isCredentialAttempt(c.req.method, c.req.path),
    // The refusal is a sign-in attempt like any other, so it goes in the audit
    // log too (admins-only, naming nobody). Better Auth never sees it, so its
    // own hooks cannot record it.
    message: RATE_LIMITED_BODY,
    onLimited: (c) => {
      recordSignInRateLimited(c.req.header('user-agent'));
      // The same bytes and type Express's `res.json` sends.
      return c.body(JSON.stringify(RATE_LIMITED_BODY), 429, {
        'Content-Type': 'application/json; charset=utf-8',
      });
    },
  });
}
