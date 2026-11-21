/**
 * Make a Wi-Fi sign-in in a test, the way a device's one-time code does
 * (DOR-4744): Wi-Fi takes no password, so tests that need a Wi-Fi session get
 * one through the same server-only endpoint the code exchange calls, inside a
 * Wi-Fi request's class, so it is stamped and capped as any Wi-Fi sign-in.
 */
import { classifyRequest } from '../../../../lib/request-classifier.js';
import { currentServerRole } from '../../../../lib/server-role.js';
import { readOwnerAccount, type Auth } from '../index.js';
import { withRegistrationCaller } from '../registration-policy.js';

/**
 * Sign the owner in on the Wi-Fi route and return the cookie pairs it set.
 *
 * @param auth - The Better Auth instance.
 * @param host - The `Host` the Wi-Fi requests in the test carry.
 * @param userAgent - The device's browser, when the test names one.
 */
export async function wifiSignInCookie(
  auth: Auth,
  host: string,
  userAgent?: string
): Promise<string> {
  const owner = readOwnerAccount();
  if (!owner) throw new Error('No owner to sign in.');
  const requestClass = classifyRequest(
    { headers: { host }, peerAddress: '127.0.0.1', ingress: 'wifi' },
    currentServerRole()
  );
  const { headers } = await withRegistrationCaller(requestClass, () =>
    auth.api.signInCheckedAccount({
      body: { userId: owner.id },
      headers: new Headers(userAgent ? { 'user-agent': userAgent } : {}),
      returnHeaders: true,
    })
  );
  return headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
