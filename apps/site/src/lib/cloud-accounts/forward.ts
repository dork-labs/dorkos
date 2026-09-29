/**
 * Hand the site's account surface to a separate accounts service, behind one
 * environment variable.
 *
 * DorkOS accounts (sign-in, the device link, the instance registry, the admin
 * console) can be served by a separate service instead of by this site. When
 * `DORKOS_CLOUD_ACCOUNTS_ORIGIN` names that service's origin, the site stops
 * serving the account surface itself and sends every request for it there.
 * **When the variable is unset, nothing here does anything and the site serves
 * every path locally, exactly as before.** That is the default, and it is what
 * every contributor, test and credential-free build runs.
 *
 * ## Two ways a request is sent on, chosen per request
 *
 * - **Redirect (307)** for a page, and for any `GET`/`HEAD` request that a
 *   browser is navigating to (an email verification link, a password-reset
 *   link). A session cookie is scoped to one host, and the accounts service
 *   sets its own on its own origin. Proxying a page would leave the browser on
 *   this host with a cookie the service never sees, and the service refuses
 *   cookie requests from an origin it does not trust. A redirect puts the
 *   browser where its cookie lives. It is temporary (307, not 308) so that
 *   turning the variable off again is not undone by a browser's cached redirect.
 * - **Proxy (rewrite)** for everything else: requests that carry a bearer
 *   token, requests with a body, and background `fetch` calls. A browser drops
 *   the `Authorization` header when it follows a redirect to another origin,
 *   and not every shipped client follows a redirect on `POST`. A proxied
 *   request keeps its method, body and headers, so a released `dorkos` binary
 *   that still calls this site's paths keeps working unchanged.
 *
 * The query string always survives, so `/activate?user_code=…` (the URL a
 * released CLI prints) lands on the same code.
 *
 * ## Who the caller is, on a proxied request
 *
 * A proxied request reaches the accounts service from this site's own address,
 * so a per-address rate limit there would count every caller together. When
 * `DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET` is also set, the site adds the caller's
 * address, as Vercel reported it, and the shared secret, and the service
 * trusts the address only beside the secret (see
 * {@link proxiedRequestHeaders}). A caller's own copy of either header is
 * always removed. Redirects never carry either.
 *
 * ## Managed connections: forwarded behind a second variable
 *
 * Managed connections (`/api/instances/connectors/**`,
 * `/api/connectors/managed/**`, `/connectors/managed/**`) authenticate against
 * the accounts this site no longer holds once forwarding is on, so they cannot
 * work here. The accounts service serves them too, and they are sent there by
 * the same two rules — **only when `DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD`
 * is also exactly `1`.** A separate switch because the service starts serving
 * them in its own release: forwarding before that would turn this site's
 * honest "not available" into the service's "not found", which a linked
 * instance reads as a missing command rather than an outage. So the order is
 * the service first, then this variable.
 *
 * With the accounts variable set and this one not, managed connections stay
 * here and report themselves not enabled (`lib/connectors/managed/config.ts`),
 * exactly as before. Either way this site's event-retention cron stands down:
 * the rows it swept are the service's, and so is the sweep.
 *
 * The site's session-to-analytics identity bridge is not mounted while
 * forwarding is on (`app/layout.tsx`): the session lives on the service's host,
 * so asking this host for it would always answer "signed out".
 *
 * @module lib/cloud-accounts/forward
 */

import { clientIpFromHeaders, UNKNOWN_CLIENT_IP } from '@/lib/rate-limit/client-ip';

/** The environment variable that turns forwarding on. Unset means off. */
export const CLOUD_ACCOUNTS_ORIGIN_VARIABLE = 'DORKOS_CLOUD_ACCOUNTS_ORIGIN';

/** The header a proxied request reports its caller's address in. */
export const PROXIED_ADDRESS_HEADER = 'x-dorkos-client-address';

/** The header that proves to the service that this site sent the address. */
export const PROXY_SECRET_HEADER = 'x-dorkos-proxy-secret';

/** The shortest shared secret that counts as set; the service applies the same floor. */
export const PROXY_SECRET_MIN_LENGTH = 32;

/**
 * Account pages: always redirected. Each entry matches itself and anything
 * below it on a segment boundary (`/account` matches `/account/instances`, not
 * `/accounts`).
 */
export const CLOUD_ACCOUNT_PAGE_PREFIXES = [
  '/signin',
  '/signup',
  '/reset-password',
  '/verify-email',
  '/activate',
  '/account',
  '/admin',
] as const;

/** Account API families matched on a segment boundary, like the pages. */
export const CLOUD_ACCOUNT_API_PREFIXES = ['/api/auth', '/api/account'] as const;

/**
 * Instance registry paths, matched EXACTLY. `/api/instances/connectors/**`
 * belongs to managed connections and stays on the site, so this family cannot
 * be a prefix.
 */
export const CLOUD_ACCOUNT_API_EXACT = [
  '/api/instances',
  '/api/instances/heartbeat',
  '/api/instances/pending',
  '/api/instances/revoke',
] as const;

/**
 * Managed-connection pages, redirected like the account pages: the browser
 * hand-off to a provider's sign-in and the account-details form, which need the
 * session the service holds.
 */
export const CLOUD_MANAGED_PAGE_PREFIXES = ['/connectors/managed'] as const;

/**
 * Managed-connection API families: the linked instance's routes (a bearer key,
 * so proxied) and the provider's callback and webhook (a browser navigation is
 * redirected to its cookie; the signed webhook is proxied with its body).
 */
export const CLOUD_MANAGED_API_PREFIXES = [
  '/api/instances/connectors',
  '/api/connectors/managed',
] as const;

/** The query parameter Next.js adds to a client-side navigation fetch. */
const NEXT_RSC_PARAM = '_rsc';

/** What to do with a request that belongs to the account surface. */
export type CloudAccountsForward =
  { readonly kind: 'redirect'; readonly url: URL } | { readonly kind: 'proxy'; readonly url: URL };

/** The parts of a request the decision reads. */
export interface ForwardableRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
}

/** The last value parsed, so a bad value is reported once rather than per request. */
let lastParsed: { readonly raw: string | undefined; readonly origin: string | null } | null = null;

/**
 * Parse the variable into a bare origin, or `null` for "off".
 *
 * Unset or empty is off. A value that is not an absolute `https` origin is also
 * off, and says so on the console once, rather than throwing: a typo must not
 * take every page on the site down. The cut-over's smoke checks are what catch
 * a variable that was meant to be on and is not. Plain `http` is accepted only
 * for a loopback host, so a local run can point at a local service. A value
 * with a path, a query or credentials is refused rather than trimmed: the
 * variable names an origin, and a trimmed value would forward somewhere other
 * than what was written.
 *
 * The value never appears in the console line.
 *
 * @param raw - The variable's value.
 * @returns The origin (scheme, host and port, no path), or `null`.
 */
export function parseCloudAccountsOrigin(raw: string | undefined): string | null {
  if (lastParsed && lastParsed.raw === raw) return lastParsed.origin;
  const origin = parseOnce(raw);
  lastParsed = { raw, origin };
  return origin;
}

/** The parse itself; see {@link parseCloudAccountsOrigin}. */
function parseOnce(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    console.error(`${CLOUD_ACCOUNTS_ORIGIN_VARIABLE} is not a URL; serving accounts locally.`);
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    console.error(`${CLOUD_ACCOUNTS_ORIGIN_VARIABLE} must be https; serving accounts locally.`);
    return null;
  }
  if (
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    console.error(
      `${CLOUD_ACCOUNTS_ORIGIN_VARIABLE} must be an origin with no path; serving accounts locally.`
    );
    return null;
  }
  return url.origin;
}

/** Whether `pathname` is `prefix` itself or below it on a segment boundary. */
function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Whether a path belongs to the account surface that forwarding sends on.
 *
 * @param pathname - The request path, without the query string.
 */
export function isCloudAccountPath(pathname: string): boolean {
  return isCloudAccountPage(pathname) || isCloudAccountApi(pathname);
}

/** Whether a path is one of the account pages. */
function isCloudAccountPage(pathname: string): boolean {
  return CLOUD_ACCOUNT_PAGE_PREFIXES.some((prefix) => underPrefix(pathname, prefix));
}

/** Whether a path is one of the account API paths. */
function isCloudAccountApi(pathname: string): boolean {
  // The site does not redirect a trailing slash away (`skipTrailingSlashRedirect`
  // in `next.config.ts`), and its router serves `/x/` as `/x`, so an exact path
  // must match with one too, or it would be served here.
  const exact = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return (
    CLOUD_ACCOUNT_API_PREFIXES.some((prefix) => underPrefix(pathname, prefix)) ||
    (CLOUD_ACCOUNT_API_EXACT as readonly string[]).includes(exact)
  );
}

/**
 * Whether a path belongs to managed connections, which forwarding sends on only
 * with `DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD` set.
 *
 * @param pathname - The request path, without the query string.
 */
export function isManagedConnectionsPath(pathname: string): boolean {
  return isManagedConnectionsPage(pathname) || isManagedConnectionsApi(pathname);
}

/** Whether a path is one of the managed-connection pages. */
function isManagedConnectionsPage(pathname: string): boolean {
  return CLOUD_MANAGED_PAGE_PREFIXES.some((prefix) => underPrefix(pathname, prefix));
}

/** Whether a path is one of the managed-connection API paths. */
function isManagedConnectionsApi(pathname: string): boolean {
  return CLOUD_MANAGED_API_PREFIXES.some((prefix) => underPrefix(pathname, prefix));
}

/**
 * Whether managed connections are forwarded too: exactly `1`, and only while
 * {@link CLOUD_ACCOUNTS_ORIGIN_VARIABLE} is set.
 *
 * @param raw - `DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD`'s value.
 * @returns `true` only for exactly `1`.
 */
export function managedConnectionsForwarding(raw: string | undefined): boolean {
  return raw === '1';
}

/**
 * Whether a request is a browser navigation that should follow its cookie.
 *
 * A safe method with no bearer token, sent either as a navigation or by a
 * client that does not say (`curl`, an older browser). A browser `fetch` says
 * `sec-fetch-mode: cors` or `same-origin`, and a redirect to another origin
 * would fail it, so those are proxied instead.
 */
function isNavigation(request: ForwardableRequest): boolean {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (request.headers.has('authorization')) return false;
  const mode = request.headers.get('sec-fetch-mode');
  return mode === null || mode === 'navigate';
}

/**
 * Decide whether and how to send a request to the accounts service.
 *
 * @param request - The incoming request.
 * @param origin - The parsed origin from {@link parseCloudAccountsOrigin}, or
 *   `null` when forwarding is off.
 * @param options.managedConnections - Whether managed connections are sent on
 *   too ({@link managedConnectionsForwarding}). Off by default.
 * @returns How to send it on, or `null` to serve it here.
 */
export function decideCloudAccountsForward(
  request: ForwardableRequest,
  origin: string | null,
  options: { readonly managedConnections?: boolean } = {}
): CloudAccountsForward | null {
  if (!origin) return null;
  const incoming = new URL(request.url);
  const managed =
    options.managedConnections === true && isManagedConnectionsPath(incoming.pathname);
  if (!managed && !isCloudAccountPath(incoming.pathname)) return null;
  // Never send a request to the origin it arrived on: a variable pointed at
  // this site would otherwise redirect every account page to itself forever.
  if (incoming.origin === origin) return null;

  const target = new URL(`${incoming.pathname}${incoming.search}`, origin);
  if (
    isCloudAccountPage(incoming.pathname) ||
    (managed && isManagedConnectionsPage(incoming.pathname))
  ) {
    // A client-side navigation's cache-busting parameter means nothing to the
    // other service; the browser falls back to a full navigation either way.
    target.searchParams.delete(NEXT_RSC_PARAM);
    return { kind: 'redirect', url: target };
  }
  return isNavigation(request) ? { kind: 'redirect', url: target } : { kind: 'proxy', url: target };
}

/**
 * Whether this deployment has handed accounts to the accounts service.
 *
 * The site's two scheduled jobs read this: once accounts are served elsewhere,
 * so is the data those jobs sweep, and the service that owns it runs them.
 *
 * @param raw - The variable's value.
 */
export function cloudAccountsForwarding(raw: string | undefined): boolean {
  return parseCloudAccountsOrigin(raw) !== null;
}

/** The last secret checked, so a bad value is reported once rather than per request. */
let lastSecret: { readonly raw: string | undefined; readonly secret: string | null } | null = null;

/**
 * The shared secret as it will be sent, or `null` for "unset".
 *
 * Surrounding whitespace is trimmed, because a pasted value often ends in a
 * newline and a header value loses it on the wire anyway. Set the same value,
 * with no surrounding whitespace, on the site and the service. What is left must be at least {@link PROXY_SECRET_MIN_LENGTH}
 * printable ASCII characters: anything else could not be sent as a header
 * value, and would make every proxied request fail, so it counts as unset and
 * says so on the console once. The value never appears in that line.
 *
 * @param raw - The variable's value.
 */
export function usableProxySecret(raw: string | undefined): string | null {
  if (lastSecret && lastSecret.raw === raw) return lastSecret.secret;
  const value = raw?.trim() ?? '';
  let secret: string | null = null;
  if (value && !/^[\x21-\x7e]+$/.test(value)) {
    console.error(
      'DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET has characters a header cannot carry; not sending it.'
    );
  } else if (value && value.length < PROXY_SECRET_MIN_LENGTH) {
    console.error(
      `DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET is shorter than ${PROXY_SECRET_MIN_LENGTH} characters; not sending it.`
    );
  } else if (value) {
    secret = value;
  }
  lastSecret = { raw, secret };
  return secret;
}

/** What {@link proxiedRequestHeaders} needs besides the request's headers. */
export interface ProxiedHeaderOptions {
  /** `DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET`, shared with the accounts service. */
  readonly secret: string | undefined;
  /**
   * Whether this deployment runs on Vercel (`VERCEL` is `1` and `VERCEL_ENV`
   * is `production` or `preview`), whose edge sets the caller's
   * address itself and replaces any value the caller sent. Anywhere else the
   * address header is the caller's own, and the site vouches for nothing.
   */
  readonly onVercel: boolean;
}

/**
 * The request headers to send with a proxied request, or `null` to send the
 * request's own headers unchanged.
 *
 * Any copy of {@link PROXIED_ADDRESS_HEADER} or {@link PROXY_SECRET_HEADER}
 * the caller sent is always removed, so a caller can never pass its own
 * through. The two are then added together, and only when the secret is set
 * (see {@link usableProxySecret}), the site is on Vercel,
 * and Vercel's header names one address. With the secret unset and neither
 * header sent, the answer is `null`: the proxied request is exactly what it was
 * before this existed.
 *
 * The secret is never logged, and never added to a redirect.
 *
 * @param headers - The incoming request's headers. Not modified.
 * @param options - The shared secret, and whether the site is on Vercel.
 * @returns The headers to proxy with, or `null` for no change.
 */
export function proxiedRequestHeaders(
  headers: Headers,
  options: ProxiedHeaderOptions
): Headers | null {
  const secret = usableProxySecret(options.secret);
  const address = options.onVercel ? clientIpFromHeaders(headers) : UNKNOWN_CLIENT_IP;
  const vouch = secret !== null && address !== UNKNOWN_CLIENT_IP;
  const carried = headers.has(PROXIED_ADDRESS_HEADER) || headers.has(PROXY_SECRET_HEADER);
  if (!vouch && !carried) return null;

  const out = new Headers(headers);
  out.delete(PROXIED_ADDRESS_HEADER);
  out.delete(PROXY_SECRET_HEADER);
  if (vouch) {
    out.set(PROXIED_ADDRESS_HEADER, address);
    out.set(PROXY_SECRET_HEADER, secret);
  }
  return out;
}
