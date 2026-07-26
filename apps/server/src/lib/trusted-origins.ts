/**
 * Network-trust resolution shared by the CORS allowlist, the `/api` host guard,
 * the bind/exposure guards, and Better Auth.
 *
 * The set of origins DorkOS accepts is dynamic: the static loopback dev origins
 * are always trusted, and the ngrok tunnel origin is added at request time once
 * a tunnel connects (so exposing the instance never needs a restart). The CORS
 * callback in `app.ts`, the `Host` allowlist in `middleware/host-guard.ts`, and
 * Better Auth's `trustedOrigins` CSRF check all read from here so there is a
 * single origin policy. {@link isLoopbackHost} lives here too, so "which names
 * mean this machine" is stated exactly once.
 *
 * @module lib/trusted-origins
 */
import { env } from '../env.js';
import { tunnelManager } from '../services/core/tunnel-manager.js';

/**
 * Host names that resolve to this machine and nowhere else. Used both for bind
 * addresses (`DORKOS_HOST`) and for inbound `Host` header validation.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Whether a host name is loopback-only (reachable only from this machine).
 * `0.0.0.0` and any other address are treated as public (non-loopback).
 *
 * @param host - A bare host name with no port, e.g. `localhost` or `::1`.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
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

/**
 * Whether a request's own `Host` header names this machine.
 *
 * Reads the RAW header on purpose. Express's `req.hostname` is NOT safe for this
 * question: `app.ts` sets `trust proxy: 1`, which makes `req.hostname` prefer
 * `X-Forwarded-Host` from the first hop — and on a direct connection the first
 * hop IS the caller. A request carrying `Host: dorkos.example.com` plus
 * `X-Forwarded-Host: localhost` therefore reports `req.hostname === 'localhost'`
 * (verified against Express 5 with a raw socket, DOR-532 review). Any check that
 * decides "is this caller local" from `req.hostname` is spoofable by anyone who
 * can reach the port; the `Host` header is the value a browser sets from the
 * address bar and a proxy rewrites deliberately, so it is the one to read.
 *
 * @param hostHeader - `req.headers.host`, the raw header value.
 */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  const hostname = parseHostname(hostHeader);
  return hostname !== null && isLoopbackHost(hostname);
}

/**
 * Static loopback dev origins the server always trusts: `localhost` and
 * `127.0.0.1` on both the API port (`DORKOS_PORT`) and the Vite dev port
 * (`VITE_PORT`, default 4241).
 */
export function getStaticLocalOrigins(): string[] {
  const port = String(env.DORKOS_PORT);
  // eslint-disable-next-line no-restricted-syntax -- VITE_PORT is a Vite-specific var not in server env.ts
  const vitePort = process.env.VITE_PORT || '4241';
  return [
    `http://localhost:${port}`,
    `http://localhost:${vitePort}`,
    `http://127.0.0.1:${port}`,
    `http://127.0.0.1:${vitePort}`,
  ];
}

/**
 * Origin of the active ngrok tunnel, resolved at call time, or `null` when no
 * tunnel is connected.
 */
export function getTunnelOrigin(): string | null {
  const tunnelUrl = tunnelManager.status.url;
  return tunnelUrl ? new URL(tunnelUrl).origin : null;
}

/**
 * Host name (no scheme, no port) of the active ngrok tunnel, or `null` when no
 * tunnel is connected. The `Host` header of a request that arrives through the
 * tunnel carries exactly this name, so the host guard compares against it.
 */
export function getTunnelHost(): string | null {
  const tunnelOrigin = getTunnelOrigin();
  return tunnelOrigin ? new URL(tunnelOrigin).hostname.toLowerCase() : null;
}

/**
 * All origins DorkOS trusts right now: the static loopback dev origins plus the
 * live tunnel origin when a tunnel is connected. Resolved dynamically so a
 * tunnel that starts after boot is trusted without a restart.
 */
export function resolveTrustedOrigins(): string[] {
  const tunnelOrigin = getTunnelOrigin();
  const origins = getStaticLocalOrigins();
  return tunnelOrigin ? [...origins, tunnelOrigin] : origins;
}
