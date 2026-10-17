/**
 * Sign-in cookies that survive plain `http` on the Wi-Fi listener (DOR-2930).
 *
 * ## Why this exists
 *
 * In a built DorkOS, Better Auth marks its cookies `Secure` and names them with
 * the `__Secure-` prefix (`AUTH_COOKIES_SECURE` in `services/core/auth`). A
 * browser keeps such a cookie only from `https` or from `localhost`. A phone
 * opening `http://studio.local:4242` is neither, so it would drop the session
 * cookie the moment sign-in set it, and the person would land back on the
 * sign-in screen forever.
 *
 * ## What it does, and where
 *
 * Only on a request whose `Host` names this computer on the network while Wi-Fi
 * access is open (`isLanAccessHost`), on whichever listener it arrived; never
 * on `localhost`, the tunnel, or anything else. Deciding by name rather than by
 * listener matters on the computer itself: a Mac resolves its own `.local` name
 * to loopback, so that request reaches the loopback listener.
 *
 * - **Out:** each `Set-Cookie` loses its `__Secure-` prefix and its `Secure`
 *   attribute, so the browser keeps it.
 * - **In:** a cookie named for Better Auth (`better-auth…`) gets the prefix
 *   back before any route reads it, so the auth stack sees the name it set.
 *
 * Dropping `Secure` here adds no exposure the listener does not already have:
 * every byte on it is plain `http`, which the switch says out loud. The cookie
 * stays scoped to the name the device used and is never sent to `localhost`.
 * Cookies ignore ports, so it also reaches any other plain-`http` service the
 * device opens on that same name, the same as a `localhost` cookie does today.
 *
 * @module services/core/lan-access/lan-cookies
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rewriteResponseSetCookies } from '../../../http/set-cookie-rewrite.js';
import { isLanAccessHost, lanCookiesNeedAdapting } from './lan-trust.js';

/** The prefix Better Auth gives its cookies when they are `Secure`. */
const SECURE_PREFIX = '__Secure-';

/** Every Better Auth cookie name starts with this (`cookiePrefix` in `services/core/auth`). */
const AUTH_COOKIE_FAMILY = 'better-auth';

/**
 * Rewrite one `Set-Cookie` value for plain `http`: drop the `__Secure-` name
 * prefix and the `Secure` attribute, keep everything else as it was.
 *
 * @param value - One `Set-Cookie` header value.
 */
export function relaxSetCookie(value: string): string {
  const [pair = '', ...attributes] = value.split(';');
  const name = pair.trimStart().startsWith(SECURE_PREFIX)
    ? pair.trimStart().slice(SECURE_PREFIX.length)
    : pair;
  const kept = attributes.filter((attribute) => attribute.trim().toLowerCase() !== 'secure');
  return [name, ...kept].join(';');
}

/**
 * Rewrite a request's `Cookie` header so Better Auth's cookies carry the
 * `__Secure-` prefix it expects. Other cookies, and cookies already prefixed,
 * pass through unchanged.
 *
 * @param header - The raw `Cookie` header.
 */
export function restoreSecureCookieNames(header: string): string {
  return header
    .split(';')
    .map((part) => {
      const trimmed = part.trim();
      return trimmed.startsWith(AUTH_COOKIE_FAMILY) ? `${SECURE_PREFIX}${trimmed}` : trimmed;
    })
    .join('; ');
}

/**
 * Adapt one request and its response to plain `http`, in place: restore the
 * cookie names on the way in, relax `Set-Cookie` on the way out. A no-op when
 * the auth cookies are not `Secure` (a development build). See
 * {@link adaptLanCookies} for when it runs.
 *
 * @param req - The incoming request; its `Cookie` header is rewritten.
 * @param res - The response, when there is one (an upgrade has none).
 * @param secureCookies - Whether auth cookies are `Secure` (`AUTH_COOKIES_SECURE`).
 */
export function adaptCookiesForPlainHttp(
  req: IncomingMessage,
  res: ServerResponse | undefined,
  secureCookies: boolean
): void {
  if (!secureCookies) return;
  const cookie = req.headers.cookie;
  if (cookie) req.headers.cookie = restoreSecureCookieNames(cookie);
  if (res) rewriteResponseSetCookies(res, relaxSetCookie);
}

/**
 * Adapt a request's cookies to plain `http` when it names this computer on the
 * network while Wi-Fi access is open; otherwise leave it alone. The front door
 * calls this for every request and upgrade (`http/front-door.ts`).
 *
 * @param req - The incoming request.
 * @param res - The response, when there is one (an upgrade has none).
 */
export function adaptLanCookies(req: IncomingMessage, res?: ServerResponse): void {
  if (!isLanAccessHost(req.headers.host)) return;
  adaptCookiesForPlainHttp(req, res, lanCookiesNeedAdapting());
}
