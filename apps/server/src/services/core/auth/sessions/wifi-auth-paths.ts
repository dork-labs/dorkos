/**
 * Which Better Auth endpoints a Wi-Fi request may reach (DOR-4744).
 *
 * Over Wi-Fi a device signs in with a one-time code from this computer
 * (`./wifi-sign-in-requests.ts`, `http/sign-in/wifi-sign-in.ts`), never a
 * password. So {@link wifiAuthPathAllowed} names the only Better Auth
 * endpoints a Wi-Fi request reaches: reading the sign-in it already has, and
 * signing out. Every sign-in, sign-up, password, key and account endpoint is
 * refused there, and a password never crosses the network in the clear.
 *
 * @module services/core/auth/sessions/wifi-auth-paths
 */

/** The Better Auth endpoints a Wi-Fi request may reach. */
const WIFI_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/get-session',
  '/api/auth/sign-out',
]);

/**
 * Whether a Wi-Fi request may reach this Better Auth endpoint.
 *
 * @param path - The normalized path Better Auth will route: lower case, no
 *   doubled or trailing slash.
 */
export function wifiAuthPathAllowed(path: string): boolean {
  return WIFI_AUTH_PATHS.has(path);
}
