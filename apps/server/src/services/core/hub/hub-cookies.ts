/**
 * A hub's sign-in cookies carry the `__Host-` prefix (DOR-2937, spec A5).
 *
 * A hub lives at its own name under a domain shared with other people's hubs.
 * A `__Host-` cookie is bound to exactly the name that set it: the browser
 * keeps it only when it is `Secure`, has `Path=/` and names no `Domain`, so no
 * other hub, and nothing else under that domain, can set, replace or shadow
 * it. Better Auth names its cookies `__Secure-…`, which a sibling name can
 * plant with a `Domain` attribute, so on a hub:
 *
 * - **Out:** each `Set-Cookie` for a sign-in cookie is renamed `__Host-…`,
 *   loses any `Domain`, and gets `Path=/` and `Secure`.
 * - **In:** a sign-in cookie that arrives under any other name is dropped,
 *   since only the hub itself could have set the `__Host-` one; that one gets
 *   its `__Secure-` name back before anything reads it, so the auth stack sees
 *   the name it set.
 *
 * A no-op on a person's own computer, and in a build whose sign-in cookies
 * are not `Secure` (a development build).
 *
 * @module services/core/hub/hub-cookies
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { rewriteResponseSetCookies } from '../../../http/set-cookie-rewrite.js';
import { currentServerRole } from '../../../lib/server-role.js';

/** The prefix Better Auth gives its cookies when they are `Secure`. */
const SECURE_PREFIX = '__Secure-';

/** The prefix that binds a cookie to exactly one name. */
const HOST_PREFIX = '__Host-';

/** Every Better Auth cookie name starts with this (`cookiePrefix` in `services/core/auth`). */
const AUTH_COOKIE_FAMILY = 'better-auth';

/**
 * Rename one `Set-Cookie` for a sign-in cookie to its `__Host-` form: no
 * `Domain`, `Path=/`, `Secure`. Other cookies pass through unchanged.
 *
 * @param value - One `Set-Cookie` header value.
 */
export function hostOnlySetCookie(value: string): string {
  const [pair = '', ...attributes] = value.split(';');
  const name = pair.trimStart();
  if (!name.startsWith(`${SECURE_PREFIX}${AUTH_COOKIE_FAMILY}`)) return value;
  const kept = attributes.filter((attribute) => {
    const key = attribute.trim().split('=')[0]!.toLowerCase();
    return key !== 'domain' && key !== 'path' && key !== 'secure';
  });
  return [`${HOST_PREFIX}${name.slice(SECURE_PREFIX.length)}`, ...kept, ' Path=/', ' Secure'].join(
    ';'
  );
}

/**
 * Rewrite a request's `Cookie` header for the auth stack: keep only the
 * `__Host-` sign-in cookies, under their `__Secure-` names. Other cookies pass
 * through unchanged.
 *
 * @param header - The raw `Cookie` header.
 */
export function restoreFromHostOnlyCookies(header: string): string {
  return header
    .split(';')
    .map((part) => part.trim())
    .flatMap((part) => {
      if (part.startsWith(`${HOST_PREFIX}${AUTH_COOKIE_FAMILY}`)) {
        return [`${SECURE_PREFIX}${part.slice(HOST_PREFIX.length)}`];
      }
      // A sign-in cookie under any other name was not set by this hub.
      const bare = part.startsWith(SECURE_PREFIX) ? part.slice(SECURE_PREFIX.length) : part;
      return bare.startsWith(AUTH_COOKIE_FAMILY) ? [] : [part];
    })
    .filter((part) => part !== '')
    .join('; ');
}

/**
 * Adapt one request and its response to `__Host-` sign-in cookies, in place,
 * on a hub. The front door calls this for every request and upgrade
 * (`http/front-door.ts`).
 *
 * @param req - The incoming request; its `Cookie` header is rewritten.
 * @param res - The response, when there is one (an upgrade has none).
 * @param secureCookies - Whether sign-in cookies are `Secure` (`AUTH_COOKIES_SECURE`).
 */
export function adaptHubCookies(
  req: IncomingMessage,
  res: ServerResponse | undefined,
  secureCookies: boolean
): void {
  if (currentServerRole() !== 'hub' || !secureCookies) return;
  const cookie = req.headers.cookie;
  if (cookie !== undefined) replaceRequestCookie(req, restoreFromHostOnlyCookies(cookie));
  if (res) rewriteResponseSetCookies(res, hostOnlySetCookie);
}

/**
 * Put `value` in place of a request's `Cookie` header, or remove it when
 * empty, in every view of the headers: Node's parsed ones, which the auth
 * stack reads, and the raw lines, which Hono reads. The parsed views are
 * built lazily from the raw lines, so they are read before the lines change.
 */
function replaceRequestCookie(req: IncomingMessage, value: string): void {
  const distinct = (req as { headersDistinct?: Record<string, string[]> }).headersDistinct;
  if (value) req.headers.cookie = value;
  else delete req.headers.cookie;
  if (distinct) {
    if (value) distinct.cookie = [value];
    else delete distinct.cookie;
  }
  const raw = req.rawHeaders;
  if (!raw) return;
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i]!.toLowerCase() === 'cookie') raw.splice(i, 2);
  }
  if (value) raw.push('Cookie', value);
}
