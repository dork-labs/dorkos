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
import type { TLSSocket } from 'node:tls';
import type { Context, Hono } from 'hono';
import type { Auth } from '../services/core/auth/index.js';
import { buildAuthRateLimiter } from '../middleware/auth-rate-limit.js';
import type { ApiEnv } from './api-chain.js';
import { honoRequestFacts } from './request-facts.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { withRegistrationCaller } from '../services/core/auth/registration-policy.js';
import { AUTH_COOKIES_SECURE } from '../services/core/auth/index.js';
import { ingressOf } from '../services/core/remote/ingress-mark.js';
import { isLoopbackHostHeader } from '../lib/trusted-origins.js';

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
  app.all('/api/auth/*', async (c) => {
    // The sign-up hook asks where this request came from (registration-policy.ts).
    const response = await withRegistrationCaller(
      classifyRequest(honoRequestFacts(c), currentServerRole()),
      () => options.auth.handler(requestForBetterAuth(c))
    );
    const secure = options.secureCookies ?? AUTH_COOKIES_SECURE;
    return (secure && explainDroppedSignIn(c, response)) || response;
  });
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
 * @returns The refusal to send instead, or `undefined` to send `response`.
 */
function explainDroppedSignIn(c: Context<ApiEnv>, response: Response): Response | undefined {
  if (!response.ok) return undefined;
  // Only a NEW sign-in: a session refresh (`get-session` renews the cookie)
  // carries a cookie the browser already kept, so it is never the loop.
  if (!/^\/api\/auth\/sign-(in|up)\//.test(c.req.path)) return undefined;
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
function requestScheme(incoming: ApiEnv['Bindings']['incoming']): string {
  const forwarded = incoming.headers['x-forwarded-proto'];
  const named = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (named) return named.split(',')[0]!.trim().toLowerCase();
  return (incoming.socket as TLSSocket | undefined)?.encrypted ? 'https' : 'http';
}

/**
 * The request Better Auth's Node adapter builds from a Node request, rebuilt
 * from the raw one here so nothing Better Auth reads changes in the move.
 *
 * - **The origin comes from `X-Forwarded-Proto`**, else the socket, and the
 *   `Host`. Better Auth has no fixed base URL (`createAuth` explains why), so
 *   this is the origin it checks a sign-in's `Origin` against. Behind a
 *   TLS-terminating proxy or the tunnel, an https page signs in only because
 *   the proxy says https; Hono's own `c.req.url` would say http.
 * - **The headers as Node parsed them**, not as Hono re-read the raw lines.
 * - **A body only when the adapter would read one**: a request with no
 *   `Content-Type`, an empty `Content-Length`, or (HTTP/1) neither a length
 *   nor chunked encoding has none.
 *
 * @param c - The Hono context.
 * @returns The request to hand `auth.handler`.
 */
export function requestForBetterAuth(c: Context<ApiEnv>): Request {
  const { incoming } = c.env;
  const headers = incoming.headers;
  const scheme =
    headers['x-forwarded-proto'] ||
    ((incoming.socket as TLSSocket | undefined)?.encrypted ? 'https' : 'http');
  const authority = (headers as Record<string, string | undefined>)[':authority'] || headers.host;
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
