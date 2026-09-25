import type { Context } from 'hono';
import type { CommunityAuth } from './auth.js';
import { ApiError, RateLimited } from './http.js';

/** Confirm the signed-in account's current password before a sensitive action. */
export type ConfirmPassword = (c: Context, accountId: string, password: string) => Promise<void>;

/**
 * Build the one password check every server-side confirmation goes through, with its guess limit.
 *
 * `auth.api.verifyPassword` is a server-side call, so Better Auth's HTTP rate limiter never sees
 * it: without this, a stolen session could guess the password as fast as the server answers.
 *
 * The budget is per host account only. Every caller here is already signed in, so the account is
 * the thing being guessed at; a per-address budget would, behind the reverse proxy the operations
 * guide describes, let one person's wrong guesses lock every account on the host out.
 *
 * Each attempt spends from the budget synchronously, before the password is checked, and a
 * correct password is refunded afterwards. Checking and spending in one step means a concurrent
 * burst cannot slip past the limit while earlier guesses are still being verified: once the
 * budget is spent, every attempt (a correct one included) is `429` without being checked, until
 * the window passes, and the `429` carries `Retry-After`. A wrong password is `403 REAUTH_FAILED`,
 * distinct from every other `403` these routes return, so a client can say "wrong password" only
 * when that is what happened. An account with no password at all is `403 PASSWORD_REQUIRED`,
 * before anything is spent.
 */
export function createPasswordConfirmation(deps: {
  auth: CommunityAuth;
  ceiling: number;
  /** Spend one attempt, or throw `RateLimited` when the budget is already spent. Must not await. */
  spend: (key: string, ceiling: number) => void;
  /** Give back one attempt spent by `spend`. */
  refund: (key: string) => void;
  /** Whether the account has a password at all; one that signs in only through OIDC does not. */
  hasPassword: (accountId: string) => Promise<boolean>;
}): ConfirmPassword {
  const { auth, ceiling, spend, refund, hasPassword } = deps;
  return async (c, accountId, password) => {
    // Reauthentication through the OIDC issuer is a later, separately reviewed step (spec open
    // question 5). Until then an account without a password is told how to get one, rather than
    // "that password is not right" for a password it never had. Nothing is spent: no guess ran.
    if (!(await hasPassword(accountId)))
      throw new ApiError(403, 'PASSWORD_REQUIRED', 'Set a password in your account to do this.');
    const key = `reauth-account:${accountId}`;
    try {
      spend(key, ceiling);
    } catch (cause) {
      if (cause instanceof RateLimited)
        throw new RateLimited(
          'Too many wrong passwords. Wait a minute, then try again.',
          cause.retryAfterSeconds
        );
      throw cause;
    }
    try {
      await auth.api.verifyPassword({ headers: c.req.raw.headers, body: { password } });
    } catch {
      throw new ApiError(403, 'REAUTH_FAILED', 'That password is not right.');
    }
    refund(key);
  };
}
