import type { Context } from 'hono';
import type { CommunityAuth } from './auth.js';
import { ApiError } from './http.js';

/** Confirm the signed-in account's current password before a destructive account action. */
export type ConfirmPassword = (c: Context, accountId: string, password: string) => Promise<void>;

/**
 * Build the password check for leave and disconnect-all, with its own guess limit.
 *
 * `auth.api.verifyPassword` is a server-side call, so Better Auth's HTTP rate limiter never sees
 * it: without this, a stolen session could guess the password as fast as the server answers.
 * Only wrong guesses count, per host account (so one account in several communities shares one
 * budget) and per socket peer. Once either budget is spent, every attempt is refused with `429`
 * before the password is checked, so a correct guess cannot be told apart from a wrong one until
 * the window passes. A wrong password is `403 REAUTH_FAILED`, distinct from every other `403`
 * these routes return, so a client can say "wrong password" only when that is what happened.
 */
export function createPasswordConfirmation(deps: {
  auth: CommunityAuth;
  ceiling: number;
  peer: (c: Context) => string;
  exhausted: (key: string, ceiling: number) => boolean;
  record: (key: string, ceiling: number) => void;
}): ConfirmPassword {
  const { auth, ceiling, peer, exhausted, record } = deps;
  return async (c, accountId, password) => {
    const keys = [`reauth-account:${accountId}`, `reauth-peer:${peer(c)}`];
    if (keys.some((key) => exhausted(key, ceiling)))
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Too many wrong passwords. Wait a minute, then try again.'
      );
    try {
      await auth.api.verifyPassword({ headers: c.req.raw.headers, body: { password } });
    } catch {
      for (const key of keys) record(key, ceiling);
      throw new ApiError(403, 'REAUTH_FAILED', 'That password is not right.');
    }
  };
}
