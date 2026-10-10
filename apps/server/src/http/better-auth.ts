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

/** Options for {@link mountBetterAuth}. */
export interface BetterAuthOptions {
  /** The Better Auth instance (`initAuth` in `services/core/auth`). */
  auth: Auth;
  /** Sign-in and sign-up attempts per address per window (`DORKOS_AUTH_SIGNIN_RATE_LIMIT`). */
  maxAttempts?: number;
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
  app.all('/api/auth/*', (c) => options.auth.handler(requestForBetterAuth(c)));
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
