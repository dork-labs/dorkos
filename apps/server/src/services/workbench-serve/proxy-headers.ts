/**
 * Header rules shared by everything that relays a dev server's response into the
 * embedded browser (DOR-216, DOR-1260).
 *
 * Two jobs, both about being able to frame a page that did not expect to be
 * framed, without changing anything else about it: drop the framing guards, and
 * know when a body may be decoded as text at all.
 *
 * @module services/workbench-serve/proxy-headers
 */

/**
 * Response headers a preview never relays: the framing guards (removing them is
 * the point) and the hop-by-hop headers, which belong to a single connection and
 * must not cross a proxy (RFC 7230 §6.1).
 *
 * `content-length` and `content-encoding` are here because the relay recomputes
 * the first and asks upstream for an unencoded body, so neither upstream value
 * can be trusted downstream.
 */
export const STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'x-frame-options',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
]);

/**
 * Request headers a preview never forwards upstream — the hop-by-hop set again,
 * which describes the browser's connection to the preview listener and says
 * nothing true about the listener's connection to the dev server.
 */
export const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Drop any `frame-ancestors` directive from a CSP header value so the proxied
 * page can be framed, leaving every other directive intact.
 *
 * @param csp - The upstream `Content-Security-Policy` value.
 * @returns The CSP with `frame-ancestors` removed, or `null` when nothing remains.
 */
export function stripFrameAncestors(csp: string): string | null {
  const kept = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !/^frame-ancestors\b/i.test(d));
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * Whether a `Content-Type` value declares UTF-8 or no charset at all — the only
 * cases the DevTools injection path may buffer-and-decode. Any other declared
 * charset (e.g. `iso-8859-1`, `shift_jis`) would be corrupted by a UTF-8 decode,
 * so those responses relay byte-for-byte uninstrumented (DOR-213).
 *
 * @param contentType - The upstream `Content-Type` header value.
 * @returns `true` when decoding as UTF-8 is faithful.
 */
export function isUtf8OrUnspecified(contentType: string): boolean {
  const match = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  if (!match) return true;
  const charset = match[1].trim().toLowerCase();
  return charset === 'utf-8' || charset === 'utf8';
}

/**
 * The prefix every Better Auth cookie carries.
 *
 * `better-auth` is the library's default and DorkOS sets no `cookiePrefix`
 * override (`services/core/auth/index.ts` configures only `advanced.
 * useSecureCookies` and `defaultCookieAttributes`), so every cookie it issues is
 * `better-auth.<name>`: `session_token`, `session_data`, `account_data`,
 * `dont_remember`, and the OAuth `state` / `nonce` / `pkce_code_verifier`. In
 * production each also gains the `__Secure-` prefix, and an oversized
 * `session_data` is split into `.0`, `.1` … chunks.
 *
 * The hyphen spellings are here because the library still READS them as a
 * compatibility fallback (`getCookie(`${prefix}.${name}`) || getCookie(
 * `${prefix}-${name}`)`, `dist/cookies/index.mjs`), so a cookie left by an older
 * install is a live credential.
 *
 * Matched as an anchored PREFIX rather than a fixed list of full names, and
 * deliberately: a list would have to enumerate the chunk suffixes, both secure
 * spellings and both separators, and would start leaking the day the library
 * adds a cookie. Anchored is still exact — it cannot match a dev app's own
 * `my-better-auth-notes` the way a substring search would.
 */
const AUTH_COOKIE_PREFIXES = [
  'better-auth.',
  'better-auth-',
  '__secure-better-auth.',
  '__secure-better-auth-',
  '__host-better-auth.',
  '__host-better-auth-',
];

/**
 * Whether a cookie NAME belongs to DorkOS rather than to the previewed app.
 *
 * The single source of truth for both directions of the pipe, because the reason
 * is the same either way: a preview origin is a different PORT on the same host
 * as the cockpit, and cookies are not scoped by port. Going out, forwarding
 * these would hand a dev server the operator's session. Coming back, relaying
 * them would let a dev server SET them — planting a session cookie the browser
 * then sends to the cockpit, or overwriting a preview's own authorization.
 *
 * @param name - The cookie name, exactly as it appeared.
 * @returns True when the cookie is DorkOS's own and must not cross.
 */
export function isDorkosCookieName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower.startsWith('dorkos_preview_')) return true;
  return AUTH_COOKIE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The `Set-Cookie` headers a preview may pass back to the browser: everything
 * the dev app sets for itself, and nothing that would touch DorkOS.
 *
 * Without this a dev server can answer
 * `Set-Cookie: better-auth.session_token=…; Path=/` and the browser will attach
 * it to the cockpit — session fixation delivered by proxied content — or
 * overwrite `dorkos_preview_<listenPort>` and knock its own preview to 401.
 * Neither needs the dev server to be malicious; one careless framework default
 * is enough.
 *
 * @param setCookie - The upstream `Set-Cookie` header value(s), if any.
 * @returns The values to relay, as an array (possibly empty).
 */
export function filterInboundSetCookies(setCookie: string | string[] | undefined): string[] {
  if (setCookie === undefined) return [];
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  return values.filter((value) => {
    const eq = value.indexOf('=');
    const name = eq === -1 ? value : value.slice(0, eq);
    return !isDorkosCookieName(name);
  });
}

/**
 * The cookies a preview may forward to the dev server: everything the dev app
 * set for itself, and nothing DorkOS set for itself.
 *
 * A preview origin is a different PORT on the same host as the cockpit, and
 * cookies are not scoped by port — so the browser attaches DorkOS's own cookies
 * to every preview request. Forwarding them would hand a local dev server the
 * operator's signed-in session and the preview's own bearer token, which is a
 * credential leak to a process that has no business with either. Both are
 * dropped by name; everything else passes through, because dev apps legitimately
 * use their own cookies.
 *
 * @param cookieHeader - The incoming `Cookie` header value, if any.
 * @returns The filtered header value, or `undefined` when nothing is left.
 */
export function filterOutboundCookies(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const kept = cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (pair === '') return false;
      const name = pair.slice(0, pair.indexOf('=') === -1 ? pair.length : pair.indexOf('='));
      return !isDorkosCookieName(name);
    });
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/**
 * Read one cookie's value out of a `Cookie` header.
 *
 * @param cookieHeader - The incoming `Cookie` header value, if any.
 * @param name - The exact cookie name to read.
 * @returns The value, or `null` when the cookie is absent.
 */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}
