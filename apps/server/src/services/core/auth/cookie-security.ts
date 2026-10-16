/**
 * Whether sign-in cookies are `Secure` in this build, in a module light
 * enough for the front door to read without loading the auth stack.
 *
 * @module services/core/auth/cookie-security
 */
import { env } from '../../../env.js';

/**
 * Whether sign-in cookies are `Secure` and carry the `__Secure-` name prefix.
 * Browsers keep such a cookie only from `https` or `localhost`, so the Wi-Fi
 * listener (`services/core/lan-access/lan-cookies.ts`) reads this to undo both
 * on its plain-http connections, and a hub (`services/core/hub/hub-cookies.ts`)
 * to give them the `__Host-` prefix.
 */
export const AUTH_COOKIES_SECURE = env.NODE_ENV === 'production';
