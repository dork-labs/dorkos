/**
 * `Host` validation for the `/api` surface — the DNS-rebinding defence for the
 * REST API, and the sibling of `middleware/mcp-origin.ts` (which does the same
 * job for `/mcp` using `Origin`).
 *
 * ## Why `Origin` is not enough here
 *
 * The CORS policy in `app.ts` allows two things a rebinding attacker gets for
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
 *    `DORKOS_TRUSTED_HOSTS`, or the live tunnel host. Anything else gets a 403.
 *
 * Matching is on the host NAME only, never the port: the Vite dev proxy, `ssh
 * -L` forwards, and `docker run -p 4300:4242` all legitimately carry a port the
 * server never listened on. A port is not a security boundary; the name is.
 *
 * @module middleware/host-guard
 */
import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { getTunnelHost, isLoopbackHost } from '../lib/trusted-origins.js';
import { configManager } from '../services/core/config-manager.js';

/**
 * Error code returned with the 403. Stable contract: clients and support docs
 * match on it.
 */
export const HOST_NOT_ALLOWED_CODE = 'HOST_NOT_ALLOWED';

/** No allocation on the common path, where `DORKOS_TRUSTED_HOSTS` is unset. */
const NO_TRUSTED_HOSTS: readonly string[] = [];

/**
 * Split the `DORKOS_TRUSTED_HOSTS` value into comparable host names: comma
 * separated, whitespace and empty entries dropped, lower-cased.
 *
 * @param raw - The raw env value, or `undefined` when it is not set.
 */
export function parseTrustedHosts(raw: string | undefined): readonly string[] {
  if (!raw) return NO_TRUSTED_HOSTS;
  return raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

/**
 * Pull the host name out of a `Host` header, dropping the port and the brackets
 * an IPv6 literal is wrapped in (`[::1]:4242` → `::1`).
 *
 * @param hostHeader - The raw `Host` header value, or `undefined` when absent.
 * @returns The lower-cased host name, or `null` when the header is missing or
 *   carries no name (HTTP/1.1 requires one, so `null` is always a rejection).
 */
export function parseHostname(hostHeader: string | undefined): string | null {
  const trimmed = hostHeader?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close > 1 ? trimmed.slice(1, close).toLowerCase() : null;
  }

  const [hostname] = trimmed.split(':');
  return hostname ? hostname.toLowerCase() : null;
}

/** The facts the host decision depends on, all resolved by the caller. */
export interface HostPolicy {
  /** The request's host name, from {@link parseHostname}. */
  hostname: string | null;
  /** Operator-configured extra host names, from {@link parseTrustedHosts}. */
  trustedHosts: readonly string[];
  /** Host name of the live tunnel, or `null` when no tunnel is connected. */
  tunnelHost: string | null;
}

/**
 * Pure predicate: whether a request's host name is one this instance answers to.
 *
 * @param policy - The resolved {@link HostPolicy}.
 */
export function isHostAllowed(policy: HostPolicy): boolean {
  const { hostname } = policy;
  if (!hostname) return false;
  if (isLoopbackHost(hostname)) return true;
  if (policy.trustedHosts.includes(hostname)) return true;
  return policy.tunnelHost !== null && hostname === policy.tunnelHost;
}

/**
 * The operator-facing 403 body. It names `DORKOS_TRUSTED_HOSTS` so someone
 * running a login-off reverse proxy reads the fix once and is done, and it never
 * lists the allowlist back (that would hand a scanner the map).
 *
 * @param hostname - The rejected host name, or `null` when no `Host` was sent.
 */
function refusalMessage(hostname: string | null): string {
  if (!hostname) {
    return (
      'Every request needs a Host header naming the address you used. ' +
      'If you reach DorkOS through a proxy, list that address in DORKOS_TRUSTED_HOSTS, ' +
      'or turn on login.'
    );
  }
  return (
    `This instance does not answer to the address "${hostname}". ` +
    'If that is how you reach DorkOS, list it in DORKOS_TRUSTED_HOSTS, or turn on login.'
  );
}

/**
 * Express middleware that rejects `/api` requests carrying a `Host` this
 * instance does not answer to, closing the DNS-rebinding path described in the
 * module doc.
 *
 * Mounted at `/api` in `createApp()` ahead of the body parser, so a rejected
 * request is answered before its payload is ever read. Inert when login is on or
 * when `DORKOS_ALLOW_INSECURE_BIND` is set; both flags are read per request, so
 * turning login on takes effect without a restart.
 *
 * @param req - The incoming request (its `Host` header is the subject).
 * @param res - The response; a rejection is a 403 with the repo's error shape.
 * @param next - Passes control on when the host is trusted.
 */
export function hostGuard(req: Request, res: Response, next: NextFunction): void {
  // Login on: Better Auth cookies are origin-scoped, so a rebound origin never
  // presents one and `sessionGate` already turns it away. Read per request so
  // enabling login takes effect immediately.
  if (configManager.get('auth')?.enabled === true) {
    next();
    return;
  }

  // The container escape hatch: the surrounding environment owns the boundary.
  if (env.DORKOS_ALLOW_INSECURE_BIND) {
    next();
    return;
  }

  const hostname = parseHostname(req.headers.host);
  const allowed = isHostAllowed({
    hostname,
    trustedHosts: parseTrustedHosts(env.DORKOS_TRUSTED_HOSTS),
    tunnelHost: getTunnelHost(),
  });

  if (allowed) {
    next();
    return;
  }

  logger.warn('[HostGuard] Rejected a request with an untrusted Host header', {
    host: hostname ?? '(missing)',
    method: req.method,
    path: req.originalUrl,
  });

  res.status(403).json({ error: refusalMessage(hostname), code: HOST_NOT_ALLOWED_CODE });
}
