/**
 * The bridge between an Express request and the one origin policy
 * (`isTrustedBrowserOrigin` in `lib/trusted-origins.ts`).
 *
 * The predicate takes resolved FACTS rather than a request, so that it stays
 * pure and the WebSocket upgrade — which has an `IncomingMessage` and no Express
 * around it — can read the same rules. This module is the Express half of that
 * split, and it exists so the CORS delegate in `app.ts` and the `/mcp` family's
 * `middleware/mcp-origin.ts` resolve those facts identically instead of each
 * reading a different set of headers.
 *
 * @module middleware/browser-origin
 */
import type { Request } from 'express';
import type { TLSSocket } from 'node:tls';
import { env } from '../env.js';
import { type BrowserOriginFacts, getTunnelHost, parseHostname } from '../lib/trusted-origins.js';
import { isHostAllowed, parseTrustedHosts } from './host-guard.js';

/** What {@link resolveBrowserOriginFacts} cannot read off the request itself. */
export interface BrowserOriginContext {
  /**
   * Whether the `Host` half of the same-origin pairing may stand down — see
   * `hostCheckInert` on `BrowserOriginFacts`. Only a surface that can point at
   * the credential gate turning a rebound origin away may pass `true`.
   */
  hostCheckInert: boolean;
}

/**
 * Read the origin decision's inputs off an Express request.
 *
 * Every value is resolved per call, never captured at mount time: a tunnel that
 * connects after boot has to be trusted without a restart, which is the reason
 * `resolveTrustedOrigins` and `getTunnelHost` are functions in the first place.
 *
 * ## Raw headers, never `req.protocol` or `req.hostname`
 *
 * Both of those getters resolve through `trust proxy`, which `app.ts` sets to
 * `1` so a reverse proxy can report the real scheme. That makes them
 * caller-controlled on a direct connection, where the "first proxy" IS the
 * caller: a request carrying `X-Forwarded-Host: localhost` reports
 * `req.hostname === 'localhost'` whatever its real `Host` said (verified against
 * Express 5 with a raw socket, DOR-532 review). A security decision that reads
 * them inherits that, silently. So the scheme is taken from `X-Forwarded-Proto`
 * explicitly — the same leftmost-entry rule `req.protocol` applies, written out
 * where it can be seen — and the host is always the raw header.
 *
 * @param req - The incoming request.
 * @param context - The facts the request cannot supply, see
 *   {@link BrowserOriginContext}.
 */
export function resolveBrowserOriginFacts(
  req: Request,
  context: BrowserOriginContext
): BrowserOriginFacts {
  const headers = req.headers;
  const forwardedProto = headers['x-forwarded-proto'];
  return {
    origin: headers.origin,
    hostHeader: headers.host,
    hostAllowed: isHostAllowed({
      hostname: parseHostname(headers.host),
      trustedHosts: parseTrustedHosts(env.DORKOS_TRUSTED_HOSTS),
      tunnelHost: getTunnelHost(),
    }),
    // eslint-disable-next-line no-restricted-syntax -- DORKOS_CORS_ORIGIN is not in env.ts; read the same way app.ts reads it
    configuredOrigins: process.env.DORKOS_CORS_ORIGIN,
    ownsNetworkBoundary: env.DORKOS_ALLOW_INSECURE_BIND === true,
    forwardedProto: Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto,
    // The server binds plain HTTP (TLS is terminated upstream), so this is
    // falsy in practice and the scheme defaults to `http` — the single scheme
    // `req.protocol` resolves to when no proxy names one.
    connectionEncrypted: Boolean((req.socket as TLSSocket).encrypted),
    hostCheckInert: context.hostCheckInert,
  };
}
