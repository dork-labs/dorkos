/**
 * Better Auth on the Hono chain: `/api/auth/*`, with the sign-in limiter in
 * front of it (DOR-2807, `plans/2026-10-express-to-hono.md` item 16).
 *
 * Both are registered through the chain's `beforeBodyParsing` seam
 * (`http/api-chain.ts`), the place Express mounted them: after the host guard
 * and CORS, before any body is parsed, and before the session gate, which
 * exempts `/api/auth/*` anyway. A route there that answers ends the chain, so
 * Better Auth reads its own body and leaves no audit-fallback row, exactly as
 * under Express.
 *
 * Better Auth gets the request its Node adapter (`better-call/node`, what
 * `toNodeHandler` wraps) built for it under Express: see
 * {@link requestForBetterAuth}. `__tests__/contract/auth.contract.test.ts` pins
 * the answers.
 *
 * @module http/better-auth
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Context, Hono } from 'hono';
import type { Auth } from '../services/core/auth/index.js';
import {
  buildAccountSignInLimiter,
  buildAuthRateLimiter,
} from '../middleware/auth-rate-limit.js';
import type { ApiEnv } from './api-chain.js';
import { honoRequestFacts } from './request-facts.js';
import { classifyRequest, type RequestClass } from '../lib/request-classifier.js';
import { isContainerPortClass } from '../services/core/auth/gate-policy.js';
import { currentServerRole } from '../lib/server-role.js';
import { withRegistrationCaller } from '../services/core/auth/registration-policy.js';
import { AUTH_COOKIES_SECURE, fromNodeHeaders } from '../services/core/auth/index.js';
import {
  mayCarrySessionCookie,
  sessionRouteOf,
  sessionWorksOn,
  withoutSessionCookies,
  type SessionRoute,
} from '../services/core/auth/sessions/session-route.js';
import { ingressOf } from '../services/core/remote/ingress-mark.js';
import { publicComputerSessionExpired } from '../services/core/hub/public-computer.js';
import { isLoopbackHostHeader } from '../lib/trusted-origins.js';
import { SETUP_CODE_HEADER, withSetupCodeAttempt } from '../services/core/auth/setup-code.js';

/** Options for {@link mountBetterAuth}. */
export interface BetterAuthOptions {
  /** The Better Auth instance (`initAuth` in `services/core/auth`). */
  auth: Auth;
  /** Sign-in and sign-up attempts per address per window (`DORKOS_AUTH_SIGNIN_RATE_LIMIT`). */
  maxAttempts?: number;
  /** Whether sign-in cookies are `Secure`; defaults to `AUTH_COOKIES_SECURE`. For tests. */
  secureCookies?: boolean;
}

/**
 * Mount the sign-in limiter and Better Auth's handler on an app built by
 * `createApiApp`. Call it from `beforeBodyParsing`.
 *
 * @param app - The Hono `/api` app, at its before-body point.
 * @param options - See {@link BetterAuthOptions}.
 */
export function mountBetterAuth(app: Hono<ApiEnv>, options: BetterAuthOptions): void {
  app.use(buildAuthRateLimiter({ maxAttempts: options.maxAttempts }));
  app.use(buildAccountSignInLimiter());
  app.all('/api/auth/*', async (c) => {
    const facts = honoRequestFacts(c);
    const setupCode = facts.headers[SETUP_CODE_HEADER];
    const requestClass = classifyRequest(facts, currentServerRole());
    // Decide on the address Better Auth will route, never on Hono's reading of
    // it: a header must not be able to make the two disagree.
    const probe = requestForBetterAuth(c);
    if (!probe) return c.json({ error: 'Bad request' }, 400);
    if (writesApiKey(new URL(probe.url).pathname) && !mayWriteApiKeys(requestClass)) {
      return c.json({ code: API_KEY_NEEDS_THIS_COMPUTER, message: API_KEY_REFUSAL }, 403);
    }
    // A session made on another route is nobody here, at these endpoints too.
    const headers = await headersForRoute(
      options.auth,
      facts.headers,
      sessionRouteOf(requestClass.route)
    );
    // Built from the same facts as `probe`, so it names the same address.
    const forHandler = headers === facts.headers ? probe : requestForBetterAuth(c, headers)!;
    // The sign-up hook asks where this request came from (registration-policy.ts)
    // and, from another device, which setup code it carried (setup-code.ts).
    const response = await withRegistrationCaller(requestClass, () =>
      withSetupCodeAttempt(
        {
          code: typeof setupCode === 'string' ? setupCode : undefined,
          address: facts.peerAddress,
        },
        () => options.auth.handler(forHandler)
      )
    );
    const secure = options.secureCookies ?? AUTH_COOKIES_SECURE;
    return (
      (secure && explainDroppedSignIn(c, response, new URL(forHandler.url).pathname)) || response
    );
  });
}

/** Refusal code for making or changing an API key anywhere but this computer. */
export const API_KEY_NEEDS_THIS_COMPUTER = 'API_KEY_NEEDS_THIS_COMPUTER';

/** What a person reads when that is refused. */
const API_KEY_REFUSAL = 'API keys can only be made on this computer.';

/**
 * Whether a path makes or changes an API key. Matched the way a router might
 * be lenient: case, doubled and trailing slashes do not slip past it.
 *
 * @param path - The request path.
 */
function writesApiKey(path: string): boolean {
  const normalized = path
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  return normalized === '/api/auth/api-key/create' || normalized === '/api/auth/api-key/update';
}

/**
 * Whether a request may make or change an API key (DOR-2969). A key is not
 * bound to a route: one made from Wi-Fi or a tunnel would work from anywhere,
 * for as long as it lives, so keys are made at this computer. A hub has no
 * "this computer" (every request is remote), so its owner makes them there. A
 * browser reaching a container through its published port counts as this
 * computer, as everywhere else (`isAtThisComputer`). With
 * `DORKOS_ALLOW_INSECURE_BIND` on, that means anywhere on the network, as the
 * session gate already treats it: the container owns its network boundary.
 *
 * @param requestClass - The classified request.
 */
export function mayWriteApiKeys(requestClass: RequestClass): boolean {
  return (
    requestClass.route === 'local' ||
    requestClass.route === 'hub' ||
    isContainerPortClass(requestClass)
  );
}

/**
 * The headers Better Auth should see for a request on `route` (DOR-2969).
 * They pass unchanged only when they carry no session cookie, or a session
 * that works on this route. Otherwise every session cookie is taken out (a
 * session made on another route, one revoked or expired whose signed snapshot
 * could still answer, or one that could not be read), so Better Auth sees
 * nobody signed in: it will not mint an API key, list or revoke sessions,
 * change the account, or renew and report that session. Signing in still
 * works, and makes a session for this route. The session gate holds the same
 * rule for the rest of the API (`verifyRequestAuth`); these endpoints are
 * exempt from it, so they need it here.
 *
 * The session is read from the server store, without renewing it.
 *
 * @param auth - The Better Auth instance.
 * @param headers - The request's raw headers.
 * @param route - The route the request came in on (`null` for the relay).
 */
async function headersForRoute(
  auth: Auth,
  headers: IncomingHttpHeaders,
  route: SessionRoute | null
): Promise<IncomingHttpHeaders> {
  const cookie = headers.cookie;
  if (!cookie || !mayCarrySessionCookie(cookie)) return headers;
  try {
    const found = await auth.api.getSession({
      headers: fromNodeHeaders(headers),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    // The same two rules the session gate applies: the route it was made on,
    // and a public-computer sign-in ends with its day.
    if (
      found &&
      sessionWorksOn(found.session, route) &&
      !publicComputerSessionExpired(found.session)
    ) {
      return headers;
    }
  } catch {
    // Unreadable: treat as a session that does not work here.
  }
  return { ...headers, cookie: withoutSessionCookies(cookie) };
}

/** Refusal code when a sign-in worked but the browser will drop its cookie. */
export const SIGN_IN_NEEDS_HTTPS = 'SIGN_IN_NEEDS_HTTPS';

/**
 * Turn a sign-in the browser is about to throw away into a refusal that says
 * why (F5, DOR-2968).
 *
 * A built DorkOS marks its sign-in cookie `Secure` (`AUTH_COOKIES_SECURE`).
 * Over plain `http` at any address but this computer's own, a browser drops a
 * `Secure` cookie without a word, so the sign-in "works" and the person lands
 * back on the sign-in screen, forever. This sees that case on the way out: a
 * response that sets a session cookie, for a plain-http request to a
 * non-loopback `Host`. The Wi-Fi listener is the exception, since it rewrites
 * the cookie for plain `http` itself (`lan-cookies.ts`).
 *
 * The account or session the request made stays; only the answer changes, so
 * the person reads what to do instead of looping.
 *
 * Only called when the cookies are `Secure`.
 *
 * @param c - The Hono context.
 * @param response - What Better Auth answered.
 * @param pathname - The path Better Auth routed.
 * @returns The refusal to send instead, or `undefined` to send `response`.
 */
function explainDroppedSignIn(
  c: Context<ApiEnv>,
  response: Response,
  pathname: string
): Response | undefined {
  if (!response.ok) return undefined;
  // Only a NEW sign-in: a session refresh (`get-session` renews the cookie)
  // carries a cookie the browser already kept, so it is never the loop.
  if (!/^\/api\/auth\/sign-(in|up)\//.test(pathname)) return undefined;
  const { incoming } = c.env;
  if (ingressOf(incoming) === 'wifi') return undefined;
  if (requestScheme(incoming) === 'https') return undefined;
  // The page itself says https: a proxy that forgot X-Forwarded-Proto, not a
  // plain-http browser. Never refuse a sign-in the browser would keep.
  if (pageIsHttps(incoming.headers.origin)) return undefined;
  if (isBrowserSecureHost(incoming.headers.host)) return undefined;
  const setsSession = response.headers
    .getSetCookie()
    .some((cookie) => /session_token=[^;]/.test(cookie));
  if (!setsSession) return undefined;
  return c.json(
    {
      code: SIGN_IN_NEEDS_HTTPS,
      message:
        'Your browser won’t keep a sign-in over plain http at this address. Open DorkOS over https, or on the computer it runs on.',
    },
    409
  );
}

/** Whether an `Origin` names an https page. */
function pageIsHttps(origin: string | undefined): boolean {
  return typeof origin === 'string' && origin.toLowerCase().startsWith('https://');
}

/**
 * Whether a browser treats a plain-http page at this `Host` as secure, and so
 * keeps a `Secure` cookie there: `localhost`, any `*.localhost`, all of
 * `127.0.0.0/8` and `[::1]`.
 */
function isBrowserSecureHost(host: string | undefined): boolean {
  if (!host) return false;
  if (isLoopbackHostHeader(host)) return true;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  const lower = name.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/.test(lower) ||
    lower === '[::1]'
  );
}

/** The scheme the person's browser used: what a proxy says, else the socket. */
function requestScheme(
  incoming: ApiEnv['Bindings']['incoming'],
  headers: IncomingHttpHeaders = incoming.headers
): 'http' | 'https' {
  return (
    forwardedScheme(headers['x-forwarded-proto']) ??
    ((incoming.socket as TLSSocket | undefined)?.encrypted ? 'https' : 'http')
  );
}

/**
 * The scheme a proxy named in `X-Forwarded-Proto`: its first item, only when
 * that is exactly `http` or `https`. Anything else is not a scheme, and is
 * ignored rather than pasted into an address.
 *
 * @param value - The raw header.
 */
export function forwardedScheme(value: string | string[] | undefined): 'http' | 'https' | null {
  const named = (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim().toLowerCase();
  return named === 'http' || named === 'https' ? named : null;
}

/**
 * A `Host` (or HTTP/2 `:authority`) fit to put in an address: a name, an IPv4
 * address or a bracketed IPv6 address, with an optional port, and nothing
 * else. No path, query, fragment or credentials can ride in on it.
 */
const AUTHORITY = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * The request Better Auth's Node adapter builds from a Node request, rebuilt
 * from the raw one here so nothing Better Auth reads changes in the move.
 *
 * - **The origin comes from `X-Forwarded-Proto`**, else the socket, and the
 *   `Host`. Only a proto of exactly `http` or `https` counts, and only a `Host`
 *   that is a name or address with an optional port, so no header can move
 *   the path Better Auth routes on. Better Auth has no fixed base URL (`createAuth` explains why), so
 *   this is the origin it checks a sign-in's `Origin` against. Behind a
 *   TLS-terminating proxy or the tunnel, an https page signs in only because
 *   the proxy says https; Hono's own `c.req.url` would say http.
 * - **The headers as Node parsed them**, not as Hono re-read the raw lines.
 * - **A body only when the adapter would read one**: a request with no
 *   `Content-Type`, an empty `Content-Length`, or (HTTP/1) neither a length
 *   nor chunked encoding has none.
 *
 * @param c - The Hono context.
 * @param headers - The headers to send, when not the request's own (see
 *   `headersForRoute`).
 * @returns The request to hand `auth.handler`, or `null` when the `Host` or
 *   the request target cannot form a plain address.
 */
export function requestForBetterAuth(
  c: Context<ApiEnv>,
  headers: IncomingHttpHeaders = c.env.incoming.headers
): Request | null {
  const { incoming } = c.env;
  const scheme = requestScheme(incoming, headers);
  const authority = (headers as Record<string, string | undefined>)[':authority'] || headers.host;
  // The target must be a path: never an absolute form that names its own host.
  if (!authority || !AUTHORITY.test(authority) || !incoming.url?.startsWith('/')) return null;
  const raw = c.req.raw;
  const init: StreamingRequestInit = {
    method: raw.method,
    // Node's own reading of the headers, as the adapter passed them: a
    // repeated header it keeps once stays once, and cookies join with `; `.
    headers: headers as Record<string, string>,
    body: carriesBody(incoming) ? raw.body : undefined,
    duplex: 'half',
    signal: raw.signal,
  };
  return new Request(`${scheme}://${authority}${incoming.url}`, init);
}

/**
 * `RequestInit` with `duplex`, which Node requires for a streamed body and
 * the DOM typings do not name yet.
 */
type StreamingRequestInit = RequestInit & { duplex: 'half' };

/** Whether Better Auth's Node adapter would read a body from this request. */
function carriesBody(incoming: ApiEnv['Bindings']['incoming']): boolean {
  if (incoming.method === 'GET' || incoming.method === 'HEAD') return false;
  const headers = incoming.headers;
  if (!headers['content-type']) return false;
  const length = Number(headers['content-length']);
  if (length === 0) return false;
  return !(
    incoming.httpVersionMajor === 1 &&
    isNaN(length) &&
    headers['transfer-encoding'] == null
  );
}
