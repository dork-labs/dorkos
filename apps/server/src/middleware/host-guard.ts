/**
 * `Host` validation for the `/api` surface — the DNS-rebinding defence for the
 * REST API, and the sibling of `middleware/mcp-origin.ts` (which does the same
 * job for `/mcp` using `Origin`).
 *
 * ## Why `Origin` is not enough here
 *
 * The CORS policy (`http/cors-policy.ts`) allows two things a rebinding attacker gets for
 * free: a request with no `Origin` at all, and a request whose `Origin` equals
 * `${req.protocol}://${req.headers.host}` (the same-origin fallback that keeps
 * Docker port remapping and SSH forwards working). A page served from
 * `http://evil.com:4242` that re-resolves `evil.com` to `127.0.0.1` is
 * same-origin from the browser's point of view, so it sends no preflight, may
 * post `application/json` freely, and satisfies both branches. With login off
 * that reaches every write route, including the one that starts an agent turn
 * with an attacker-chosen working directory. The one header the attacker cannot
 * forge in that scenario is `Host`: the browser sets it from the name in the
 * address bar, and that name is `evil.com`.
 *
 * ## The rule
 *
 * 1. **Login on → skip.** Better Auth cookies are scoped to the real origin, so
 *    a rebound origin carries no cookie and the session gate already rejects it.
 *    Skipping keeps reverse-proxy and remote deployments working unchanged, on
 *    any host name, with no new configuration.
 * 2. **`DORKOS_ALLOW_INSECURE_BIND` → skip.** Containers own their own network
 *    boundary; the official Docker image sets this, and its behaviour is
 *    unchanged.
 * 3. **Otherwise enforce.** The request's host name must be loopback, listed in
 *    `DORKOS_TRUSTED_HOSTS`, the live tunnel host, or, while Wi-Fi access is
 *    open, this computer's own `.local` name or network address. Anything else
 *    gets a 403.
 *
 * Matching is on the host NAME only, never the port: the Vite dev proxy, `ssh
 * -L` forwards, and `docker run -p 4300:4242` all legitimately carry a port the
 * server never listened on. A port is not a security boundary; the name is.
 *
 * The header is read RAW (`req.headers.host`), never through `req.hostname` —
 * see `isLoopbackHostHeader` in `lib/trusted-origins.ts` for why that getter is
 * attacker-controlled under `trust proxy`.
 *
 * @module middleware/host-guard
 */
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import {
  getTunnelHosts,
  isHostAllowed,
  parseHostname,
  parseTrustedHosts,
} from '../lib/trusted-origins.js';
import { getLanAccessHosts } from '../services/core/lan-access/lan-trust.js';
import { configManager } from '../services/core/config-manager.js';
import { redactLogPath } from './request-logger.js';
import { problemBody } from '@dorkos/http-kit';
import type { Problem } from '@dorkos/shared/problem';

/**
 * The operator-facing 403 sentence. It names `DORKOS_TRUSTED_HOSTS` so someone
 * running a login-off reverse proxy reads the fix once and is done, and it never
 * lists the allowlist back (that would hand a scanner the map).
 *
 * @param hostname - The rejected host name, or `null` when no `Host` was sent.
 */
function refusalMessage(hostname: string | null): string {
  if (!hostname) {
    return 'Send a Host header. Behind a proxy, add it to DORKOS_TRUSTED_HOSTS, or turn on login.';
  }
  return `DorkOS doesn’t answer to "${hostname}". Add it to DORKOS_TRUSTED_HOSTS, or turn on login.`;
}

/**
 * Decide whether an `/api` request's `Host` is one this instance answers to,
 * closing the DNS-rebinding path described in the module doc.
 *
 * The chain (`http/api-chain.ts`) asks it for every `/api` request, before the
 * body is read. Inert when login is on or when
 * `DORKOS_ALLOW_INSECURE_BIND` is set; both flags are read per request, so
 * turning login on takes effect without a restart.
 *
 * @param host - The RAW `Host` header, never a framework's parsed host name.
 * @param method - The request method, for the log line.
 * @param url - The request URL as sent (path and query), for the log line.
 * @returns The `403 host_not_allowed` problem to answer with, or `null` when
 *   the request may pass.
 */
export function refuseUntrustedHost(
  host: string | undefined,
  method: string,
  url: string
): Problem | null {
  // Login on: Better Auth cookies are origin-scoped, so a rebound origin never
  // presents one and the session gate already turns it away. Read per request
  // so enabling login takes effect immediately.
  if (configManager.get('auth')?.enabled === true) return null;

  // The container escape hatch: the surrounding environment owns the boundary.
  if (env.DORKOS_ALLOW_INSECURE_BIND) return null;

  const hostname = parseHostname(host);
  const allowed = isHostAllowed({
    hostname,
    trustedHosts: parseTrustedHosts(env.DORKOS_TRUSTED_HOSTS),
    tunnelHosts: getTunnelHosts(),
    lanHosts: getLanAccessHosts(),
  });
  if (allowed) return null;

  logger.warn('[HostGuard] Rejected a request with an untrusted Host header', {
    host: hostname ?? '(missing)',
    method,
    // No query string, and no video link ticket in any spelling (DOR-4321, DOR-4736).
    path: redactLogPath(url),
  });
  return problemBody('host_not_allowed', { detail: refusalMessage(hostname) });
}
