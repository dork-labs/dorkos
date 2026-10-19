/**
 * Which browser a hub request came from, for the `device` a relayed request
 * carries to the computer (spec `everything-is-a-space` step B3, DOR-2946), so
 * the computer can tell its owner when a browser it has never seen uses chat
 * from the web.
 *
 * - **The id** is a random value in a cookie of its own, set by the hub the
 *   first time the owner's browser reaches `/api/hub/computers` without one.
 *   It is never the sign-in token, never derived from it, and says nothing
 *   about the session: signing out and in again is the same browser, and
 *   another browser is never the same one. `HttpOnly`, `SameSite=Lax`, and on
 *   a `Secure` build `__Host-` bound, so no sibling name can plant one.
 * - **The label** is read from the `User-Agent` by `lib/http/user-agent.ts`, e.g.
 *   `Safari on iPhone`. A hint for the owner, never a check.
 *
 * A request without the cookie names no device; the answer to it sets one.
 *
 * @module services/core/hub-relay/browser-device
 */
import { randomBytes } from 'node:crypto';
import type { RelayDevice } from '@dorkos/shared/session-relay';
import { RelayDeviceSchema } from '@dorkos/shared/session-relay';
import { describeUserAgent } from '../../../lib/http/user-agent.js';

/** How long the browser keeps the cookie: 400 days, the most browsers allow. */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * The cookie's name: `__Host-` bound on a `Secure` build, plain on a
 * development build served over http.
 *
 * @param secure - Whether cookies are `Secure` (`AUTH_COOKIES_SECURE`).
 */
export function browserDeviceCookieName(secure: boolean): string {
  return secure ? '__Host-dorkos-device' : 'dorkos-device';
}

/** A fresh device id: 16 random bytes, base64url. */
export function mintBrowserDeviceId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * The `Set-Cookie` value that gives this browser its id.
 *
 * @param id - From {@link mintBrowserDeviceId}.
 * @param secure - Whether cookies are `Secure`.
 */
export function browserDeviceSetCookie(id: string, secure: boolean): string {
  return [
    `${browserDeviceCookieName(secure)}=${id}`,
    'Path=/',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * The device id the browser's cookie carries, or `null` when it has none or
 * it is not one this hub could have set.
 *
 * @param cookieHeader - The request's `Cookie` header.
 * @param secure - Whether cookies are `Secure`.
 */
export function browserDeviceId(cookieHeader: string | undefined, secure: boolean): string | null {
  if (!cookieHeader) return null;
  const name = `${browserDeviceCookieName(secure)}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(name)) continue;
    const id = trimmed.slice(name.length);
    return RelayDeviceSchema.shape.id.safeParse(id).success ? id : null;
  }
  return null;
}

/**
 * The device a relayed request names, or `null` when the browser has no id yet.
 *
 * @param headers - The request's `Cookie` and `User-Agent` headers.
 * @param secure - Whether cookies are `Secure`.
 */
export function browserDevice(
  headers: { cookie?: string; userAgent?: string },
  secure: boolean
): RelayDevice | null {
  const id = browserDeviceId(headers.cookie, secure);
  return id ? { id, label: describeUserAgent(headers.userAgent) } : null;
}
