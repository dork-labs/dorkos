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
import { isIPv4 } from 'node:net';
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
 * (verified against Express 5 with a raw socket, DOR-532 review).
 *
 * What this answers is "which name did the caller ask for", which is the right
 * question for browser DNS rebinding, because a browser sets `Host` from the
 * address bar and cannot lie about it. It is NOT a proof of locality: a
 * non-browser caller writes `Host` as freely as any other header. Anything
 * deciding "is this caller on this machine" must ALSO check the TCP peer with
 * {@link isLoopbackPeer}.
 *
 * @param hostHeader - `req.headers.host`, the raw header value.
 */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  const hostname = parseHostname(hostHeader);
  return hostname !== null && isLoopbackHost(hostname);
}

/**
 * Whether the other end of the TCP connection is on this machine.
 *
 * This is the only locality signal a caller cannot write: it comes from the
 * socket, not from a header. Pass `req.socket.remoteAddress` — deliberately NOT
 * `req.ip`, which Express derives through `trust proxy` from `X-Forwarded-For`
 * and is therefore caller-controlled, the very bug this replaces.
 *
 * Handles the shapes Node reports: the whole `127.0.0.0/8` block (a local caller
 * may legitimately use `127.0.0.2`), IPv6 `::1`, the `::ffff:127.0.0.1`
 * v4-mapped form a dual-stack listener reports for IPv4 peers, and a trailing
 * `%zone` index. A missing address (a socket already torn down) is not local.
 *
 * ## The residual
 *
 * A reverse proxy running on this same host connects from `127.0.0.1`, so its
 * forwarded requests are indistinguishable from a genuinely local caller's. That
 * is inherent to the signal, not an oversight: at the socket layer there is
 * nothing left to tell them apart. Pairing this with
 * {@link isLoopbackHostHeader} narrows it — such a proxy normally forwards its
 * own public `Host` — but an operator who configures the proxy to rewrite `Host`
 * to `localhost` re-opens it. Deployments that expose DorkOS should require a
 * login, which gates these routes independently.
 *
 * @param address - `req.socket.remoteAddress`.
 */
export function isLoopbackPeer(address: string | undefined): boolean {
  let addr = address?.trim().toLowerCase();
  if (!addr) return false;

  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);

  if (isIPv4(addr)) return addr.startsWith('127.');
  return addr === '::1' || addr === '0:0:0:0:0:0:0:1';
}

/** The facts {@link isLocalRequest} decides on, all resolved by the caller. */
export interface LocalRequestFacts {
  /** `req.socket.remoteAddress` — the TCP peer, the part a caller cannot write. */
  peer: string | undefined;
  /** `req.headers.host` — the raw header, the part a browser cannot lie about. */
  hostHeader: string | undefined;
  /** `env.DORKOS_ALLOW_INSECURE_BIND`, read by the caller so this stays pure. */
  allowInsecureBind: boolean;
}

/**
 * Whether a request may reach an action reserved for a person at this machine.
 *
 * Both signals are required, because each alone admits a different attacker:
 * the peer stops a remote caller forging `Host: localhost`, and the `Host`
 * header stops a DNS-rebound browser whose peer genuinely is `127.0.0.1`. See
 * {@link isLoopbackPeer} and {@link isLoopbackHostHeader} for each half, and the
 * residual neither closes.
 *
 * `allowInsecureBind` short-circuits both, matching what that flag already does
 * to the `/api` host guard: it declares that the surrounding environment owns
 * the network boundary. It is also the only way these actions can work inside a
 * container, where the browser's request arrives from the bridge gateway rather
 * than loopback.
 *
 * Pure, and takes resolved facts rather than a request, following the predicates
 * in `services/core/auth/exposure-guard.ts`. That keeps the flag testable
 * without mutating the shared `env` singleton — which, done from one test file,
 * leaked into another and turned a real 403 assertion green.
 *
 * @param facts - The resolved {@link LocalRequestFacts}.
 */
export function isLocalRequest(facts: LocalRequestFacts): boolean {
  if (facts.allowInsecureBind) return true;
  return isLoopbackPeer(facts.peer) && isLoopbackHostHeader(facts.hostHeader);
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
