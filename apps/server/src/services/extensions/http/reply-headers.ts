/**
 * The one rule for which reply headers an extension may send on DorkOS's
 * origin, for every reply DorkOS gets to look at before it goes out: a fetch
 * handler's `Response`, in the server's process or in its own
 * (`fetch-handler.ts`, `isolation/isolated-router.ts`). An Express router
 * writes straight to the socket in the server's process, so this cannot
 * reach it; that is one reason the router is on its way out (DOR-2856).
 *
 * - **Allowed:** an allowlist ({@link OUTBOUND_ALLOWED}) of content and
 *   caching headers, other `x-` headers (never `x-dorkos-`), and a
 *   `location` only back into the extension's own mount.
 * - **Dropped:** everything else, `set-cookie` and `clear-site-data`
 *   included. An allowlist, because the dangerous ones are an open set
 *   (`refresh`, `www-authenticate` raising a password prompt on DorkOS's
 *   origin, `service-worker-allowed`, `strict-transport-security`, CORS and
 *   CSP overrides).
 * - **Always set:** {@link OUTBOUND_FORCED}, so a reply opened as a page
 *   cannot run script on DorkOS's origin.
 *
 * @module services/extensions/http/reply-headers
 */
import type http from 'node:http';

/**
 * The reply headers an extension may set, by exact name. `location` is
 * allowed separately ({@link sameMountLocation}); other `x-` headers (but no
 * `x-dorkos-`) pass, since browsers give none of them a meaning that crosses
 * the CSP {@link OUTBOUND_FORCED} sets.
 */
const OUTBOUND_ALLOWED = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'cache-control',
  'expires',
  'pragma',
  'etag',
  'last-modified',
  'vary',
  'retry-after',
  'date',
]);

/** Set on every reply from an extension's fetch handler. */
export const OUTBOUND_FORCED: Readonly<Record<string, string>> = {
  'content-security-policy': "sandbox; default-src 'none'",
  'x-content-type-options': 'nosniff',
};

/**
 * A `location` the reply may carry: one that, resolved against the request,
 * stays on the same origin and inside the extension's own mount. Anything
 * else (another site, another DorkOS route, `//host`) is dropped, so an
 * extension can't make DorkOS's origin an open redirect or send the person's
 * browser to a DorkOS route with their cookie.
 *
 * @param value - The `location` header.
 * @param mount - The extension's mount, `/api/ext/<id>`.
 * @returns The header to send, or `null` to drop it.
 */
export function sameMountLocation(
  value: string | string[] | undefined,
  mount: string
): string | null {
  if (typeof value !== 'string' || value.includes('\\')) return null;
  const base = new URL(`http://dorkos.invalid${mount}/`);
  let target: URL;
  try {
    target = new URL(value, base);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  if (target.pathname !== mount && !target.pathname.startsWith(`${mount}/`)) return null;
  return `${target.pathname}${target.search}${target.hash}`;
}

/**
 * A fetch handler's `location` as the person's browser must see it. The
 * handler lives below its mount (`/items` is `/api/ext/<id>/items`), so a
 * location on its own origin is moved under the mount, the way a reverse
 * proxy rewrites one. A location on any other origin is left as it is, for
 * {@link sameMountLocation} to drop.
 *
 * @param value - The `location` the handler set.
 * @param handlerUrl - The URL of the request the handler was given.
 * @param mount - The extension's mount, `/api/ext/<id>`.
 * @returns The location in DorkOS's terms, or `null` when it can't be read.
 */
export function mountedLocation(value: string, handlerUrl: string, mount: string): string | null {
  if (value.includes('\\')) return null;
  let target: URL;
  try {
    target = new URL(value, handlerUrl);
  } catch {
    return null;
  }
  if (target.origin !== new URL(handlerUrl).origin) return value;
  return `${mount}${target.pathname}${target.search}${target.hash}`;
}

/**
 * Whether a reply header other than `location` may pass.
 *
 * @param name - The header's name, lower-case.
 */
function allowed(name: string): boolean {
  return OUTBOUND_ALLOWED.has(name) || (name.startsWith('x-') && !name.startsWith('x-dorkos-'));
}

/**
 * The reply headers passed back to the person, from a Node reply (an
 * extension in its own process): only the allowed ones, plus the forced pair.
 *
 * @param headers - The reply's headers (lower-case names).
 * @param mount - The extension's mount, `/api/ext/<id>`.
 */
export function outboundHeaders(
  headers: http.IncomingHttpHeaders,
  mount: string
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (key === 'location') {
      const location = sameMountLocation(value, mount);
      if (location !== null) out.location = location;
      continue;
    }
    if (allowed(key)) out[key] = value;
  }
  return { ...out, ...OUTBOUND_FORCED };
}

/**
 * The same rule for a web `Headers` (a fetch handler's `Response` in the
 * server's process), with its `location` first moved under the mount
 * ({@link mountedLocation}).
 *
 * @param headers - The reply's headers.
 * @param mount - The extension's mount, `/api/ext/<id>`.
 * @param handlerUrl - The URL of the request the handler was given.
 */
export function outboundWebHeaders(headers: Headers, mount: string, handlerUrl: string): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    if (key === 'location') {
      const mounted = mountedLocation(value, handlerUrl, mount);
      const location = mounted === null ? null : sameMountLocation(mounted, mount);
      if (location !== null) out.set('location', location);
      return;
    }
    if (allowed(key)) out.append(key, value);
  });
  for (const [key, value] of Object.entries(OUTBOUND_FORCED)) out.set(key, value);
  return out;
}
