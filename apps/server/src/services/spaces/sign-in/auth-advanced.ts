import type { BetterAuthOptions } from 'better-auth';
import type { CommunityConfig } from '../config.js';
import { CALLER_ADDRESS_HEADER } from '../caller-address.js';

/**
 * Better Auth's `advanced` options: cookie flags, and where it reads a caller's address.
 *
 * Better Auth keys its own rate limits (sign-in and the rest of `/api/auth/*`) and each session's
 * recorded address by that address. It reads it only from `CALLER_ADDRESS_HEADER`, which this
 * server sets from `callerAddress` (the socket peer, or the trusted proxy's header) on every
 * request it hands Better Auth, so it counts callers exactly as this server's own limiters do.
 * Its default, `X-Forwarded-For`, is never read: with no proxy in front, a caller sends that
 * header itself and would pick its own bucket (DOR-2846).
 */
export function authAdvancedOptions(
  config: Pick<CommunityConfig, 'publicUrl'>
): BetterAuthOptions['advanced'] {
  const secure = config.publicUrl.startsWith('https:');
  return {
    useSecureCookies: secure,
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure },
    ipAddress: { ipAddressHeaders: [CALLER_ADDRESS_HEADER] },
  };
}
