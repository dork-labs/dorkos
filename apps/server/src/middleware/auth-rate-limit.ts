import type { Request } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

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
 * @param req - The incoming request (its full `path` and `method` are read).
 * @returns `true` when the request is a password sign-in/sign-up POST to count.
 */
function isCredentialAttempt(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const path = req.path.toLowerCase();
  return path === '/api/auth/sign-in/email' || path === '/api/auth/sign-up/email';
}

/**
 * Build the app-level rate limiter for Better Auth's sign-in / sign-up endpoints.
 *
 * Defense-in-depth for local password brute-force (DOR-281). Mounted app-wide in
 * `app.ts` ahead of the Better Auth handler; it counts only credential-guessing
 * POSTs ({@link isCredentialAttempt}) and skips everything else, so session-check
 * GETs and non-auth routes are untouched.
 *
 * This layers over — it does not replace — Better Auth's own built-in throttle.
 * Better Auth applies a special rule (window 10s, max 3) to `/sign-in`,
 * `/sign-up`, `/change-password`, and `/change-email`, but only when its
 * `rateLimit.enabled` resolves truthy, which defaults to `isProduction`. That
 * inner layer is therefore absent outside production and, even when present, its
 * short window permits a high sustained guess rate. This limiter is
 * environment-independent and window-based, closing both gaps.
 *
 * Keys on `req.ip`, which resolves from `X-Forwarded-For` because `app.ts` sets
 * `trust proxy, 1` — identical IP handling to the `/mcp` and `/a2a` limiters.
 * SECURITY: like those, this holds only behind a single trusted proxy; on a
 * direct public bind a client can rotate spoofed XFF values across buckets, so
 * treat it as a throttle backstopped by auth, not a hard boundary.
 *
 * @param options - Per-limiter overrides (default: 10 attempts per window).
 * @returns An `express-rate-limit` handler returning a clean JSON `429`.
 */
export function buildAuthRateLimiter(options: AuthRateLimitOptions = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    // Count only sign-in/sign-up POSTs; benign session-check GETs and every
    // non-auth route pass through without consuming the budget.
    skip: (req) => !isCredentialAttempt(req),
    message: {
      error: 'Too many sign-in attempts. Try again in a few minutes.',
      code: 'RATE_LIMITED',
    },
  });
}
