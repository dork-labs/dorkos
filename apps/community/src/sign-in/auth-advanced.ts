import type { BetterAuthOptions } from 'better-auth';
import type { CommunityConfig } from '../config.js';

/**
 * Better Auth's `advanced` options: cookie flags, and where it reads a caller's address.
 *
 * Better Auth keys its own rate limits (sign-in and the rest of `/api/auth/*`) and each session's
 * recorded address by that address. Behind a trusted proxy every caller shares the proxy's
 * socket, so it reads the same header this server's own limiters do (`callerAddress`). With no
 * proxy header configured it keeps its default source.
 */
export function authAdvancedOptions(
  config: Pick<CommunityConfig, 'publicUrl' | 'trustedProxyHeader'>
): BetterAuthOptions['advanced'] {
  const secure = config.publicUrl.startsWith('https:');
  return {
    useSecureCookies: secure,
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure },
    ...(config.trustedProxyHeader
      ? { ipAddress: { ipAddressHeaders: [config.trustedProxyHeader] } }
      : {}),
  };
}
