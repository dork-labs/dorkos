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
 * in `services/core/auth/exposure-guard.ts`. That keeps the flag branch testable
 * without mutating the shared `env` singleton for the length of a test, which is
 * the pattern worth having whatever the runner's isolation settings happen to be.
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

/** The facts {@link isTrustedUpgradeOrigin} decides on, all resolved by the caller. */
export interface UpgradeOriginFacts {
  /** The upgrade's `Origin` header. Absent for every non-browser client. */
  origin: string | undefined;
  /** The upgrade's raw `Host` header — what the caller asked for. */
  hostHeader: string | undefined;
  /** Whether this instance answers to that `Host` (`isHostAllowed`). */
  hostAllowed: boolean;
  /** `DORKOS_CORS_ORIGIN`, the operator's explicit allowlist (or `*`). */
  configuredOrigins: string | undefined;
  /** `DORKOS_PUBLIC_URL`, the address the operator publishes. */
  publicUrl: string | undefined;
  /**
   * Whether the surrounding environment owns the network boundary
   * (`DORKOS_ALLOW_INSECURE_BIND`), or login is on — in which case
   * origin-scoped auth cookies already turn a rebound origin away, exactly as
   * `hostGuard` reasons.
   */
  hostCheckInert: boolean;
}

/**
 * Whether a WebSocket upgrade's `Origin` may be trusted.
 *
 * ## Why this is not just `resolveTrustedOrigins().includes(origin)`
 *
 * That was the first version, and it broke every non-loopback deployment. The
 * trap is that a browser sends `Origin` on **every** WebSocket handshake,
 * including a same-origin one, whereas the same-origin `fetch` that carried the
 * SSE streams sent none. So this check was inert for the durable streams before
 * they became sockets and is decisive after — and a loopback-only allowlist
 * turns into "the SPA renders, REST works, the turn runs, the reply lands on
 * disk, and the browser never shows it" for anyone behind a reverse proxy, on a
 * LAN IP, on `https://`, or setting `DORKOS_CORS_ORIGIN`.
 *
 * So it mirrors what the HTTP surface already does, which is CORS **and**
 * `hostGuard` **together** (`app.ts` `buildCors` + `middleware/host-guard.ts`),
 * and is exactly as strict as those two are jointly:
 *
 * 1. **No `Origin`** — a non-browser client (CLI, tests, the desktop shell).
 *    Passes, like the CORS delegate and `validateMcpOrigin`: a header a browser
 *    is forced to send truthfully proves nothing by its absence.
 * 2. **A statically trusted origin** — loopback dev origins, the live tunnel.
 * 3. **An origin the operator configured** — `DORKOS_CORS_ORIGIN` (including
 *    `*`) or `DORKOS_PUBLIC_URL`. The HTTP path already honours the first; a
 *    socket refusing what a request accepts is the inconsistency that made this
 *    a silent outage rather than an error somebody could read.
 * 4. **Same-origin with this very request** — the `Origin`'s host equals the
 *    `Host` this request asked for. This is the branch that covers reverse
 *    proxies, LAN addresses and `https://` without the operator listing every
 *    one.
 *
 * Branch 4 is only sound **paired with the host allowlist**, which is why
 * `hostAllowed` is required rather than assumed. A DNS-rebound page at
 * `evil.com` pointing at 127.0.0.1 is same-origin to the browser and sends
 * `Host: evil.com` with `Origin: http://evil.com` — branch 4 alone would admit
 * it. `isHostAllowed` rejects the `Host`, and the pairing is the same one
 * `hostGuard` provides for requests. When the host check is inert (login on, or
 * the container escape hatch) branch 4 stands alone, for the same reason
 * `hostGuard` stands down there: auth cookies are origin-scoped, so a rebound
 * origin never presents one.
 *
 * @param facts - The resolved {@link UpgradeOriginFacts}.
 */
export function isTrustedUpgradeOrigin(facts: UpgradeOriginFacts): boolean {
  const { origin } = facts;
  if (!origin) return true;

  if (resolveTrustedOrigins().includes(origin)) return true;

  const configured = facts.configuredOrigins?.trim();
  if (configured === '*') return true;
  if (
    configured &&
    configured
      .split(',')
      .map((entry) => entry.trim())
      .includes(origin)
  ) {
    return true;
  }

  if (facts.publicUrl) {
    try {
      if (new URL(facts.publicUrl).origin === origin) return true;
    } catch {
      // A malformed DORKOS_PUBLIC_URL trusts nothing extra, rather than throwing
      // on the upgrade path.
    }
  }

  // Same-origin as this request, gated on the host allowlist (see the doc).
  if (!facts.hostAllowed && !facts.hostCheckInert) return false;
  const requestedHost = parseHostname(facts.hostHeader);
  if (!requestedHost) return false;
  try {
    return new URL(origin).hostname.toLowerCase() === requestedHost;
  } catch {
    return false;
  }
}
