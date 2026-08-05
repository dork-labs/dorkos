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
   * `X-Forwarded-Proto`, when a proxy set it — the upgrade's equivalent of the
   * `trust proxy` that lets `req.protocol` see through Caddy or ngrok.
   *
   * Present, it pins the same-origin comparison to ONE scheme. Absent, both are
   * accepted, because a TLS-terminating proxy that forwards neither the scheme
   * nor a trusted host would otherwise be unserviceable.
   */
  forwardedProto: string | undefined;
  /**
   * Whether the host pairing below may stand down.
   *
   * True for a CREDENTIAL-GATED route when login is on, and only then: an auth
   * cookie is origin-scoped, so a rebound origin cannot present one and the
   * credential gate turns it away before any data moves.
   *
   * It deliberately does NOT include `DORKOS_ALLOW_INSECURE_BIND`, even though
   * `hostGuard` stands down for it. Both Docker targets set that flag, so
   * honouring it here left the origin unchecked exactly where the shipped image
   * runs — and on a `bearer-of-id` route (the terminal) that is a shell on the
   * host for any page that rebinds DNS to the published address. The stated
   * reason above covers login-on and nothing else, so neither does this.
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
 * `hostGuard` **together** (`app.ts` `buildCors` + `middleware/host-guard.ts`):
 *
 * 1. **No `Origin`** — a non-browser client (CLI, tests, the desktop shell).
 *    Passes, like the CORS delegate and `validateMcpOrigin`: a header a browser
 *    is forced to send truthfully proves nothing by its absence.
 * 2. **A statically trusted origin** — loopback dev origins, the live tunnel.
 * 3. **An origin the operator configured** — `DORKOS_PUBLIC_URL`, or a name in
 *    `DORKOS_CORS_ORIGIN`. The HTTP path already honours these; a socket
 *    refusing what a request accepts is the inconsistency that made this a
 *    silent outage rather than an error somebody could read. An explicit
 *    `DORKOS_CORS_ORIGIN` list is EXHAUSTIVE here as it is in `buildCors` —
 *    branch 4 does not run under it.
 *
 *    **`DORKOS_CORS_ORIGIN='*'` is deliberately not honoured**, and that is the
 *    one place this is stricter than CORS rather than equal to it. The wildcard
 *    is tolerable on HTTP only because a wildcard `Access-Control-Allow-Origin`
 *    is invalid for credentialed requests, so browsers reject it whatever the
 *    server says (`app.ts`). A WebSocket handshake has no such backstop:
 *    cookies attach automatically and there is no ACAO to reject. Honouring it
 *    would have meant that with login ON plus `*`, the HTTP API stayed closed
 *    to a cross-origin page while every durable stream and the terminal were
 *    wide open to it. The wildcard is treated as "no list", so the other
 *    branches still decide.
 * 4. **Same-origin with this very request** — the `Origin` equals
 *    `<scheme>://<Host>` for the `Host` this request asked for. This is the
 *    branch that covers reverse proxies, LAN addresses and `https://` without
 *    the operator listing every one. It is an EXACT string comparison, matching
 *    `buildCors`'s `` `${req.protocol}://${host}` ``.
 *
 * ## Branch 4 compares the whole origin, and that is the whole point
 *
 * An earlier version compared only the HOSTNAME, dropping scheme and port. That
 * is a hole rather than a shortcut, and a bad one on a default zero-config
 * install: a page served by ANY other process on this machine —
 * `localhost:9999` running some project's dev server, a docs preview, a
 * notebook — sends `Origin: http://localhost:9999` with `Host: localhost:4242`,
 * whose hostnames are equal. It would have been handed the global stream, which
 * carries every session's id and cwd, and could then have opened each session's
 * stream and read the transcripts. Login does not close it either: cookies
 * ignore port, so `localhost:9999` presents the cockpit's own cookie.
 *
 * Comparing the whole origin costs nothing — every intended deployment
 * (reverse-proxied, LAN IP, `https://localhost`) sends an `Origin` that matches
 * its `Host` exactly.
 *
 * ## The scheme, when no proxy names it
 *
 * With `X-Forwarded-Proto` the comparison is pinned to that one scheme. Without
 * it, BOTH schemes are accepted for the same `Host`. That is exact when `Host`
 * carries a port, because nothing but the server on that port can hold it. It
 * is a real (small) widening when `Host` has no port — the reverse-proxy case:
 * `http://example.com` is port 80 and `https://example.com` is 443, which are
 * different servers, so a script an attacker controls on the **plaintext**
 * vhost of that same name would match. The nginx and Caddy configs this repo
 * ships both set `X-Forwarded-Proto`, which closes it; the residual is a custom
 * proxy that forwards neither the scheme nor a trusted host. Forging the header
 * cannot widen anything — supplying it replaces the two-scheme OR with a single
 * equality.
 *
 * Branch 4 is additionally **paired with the host allowlist**, which is why
 * `hostAllowed` is required rather than assumed. A DNS-rebound page at
 * `evil.com` pointing at 127.0.0.1 is same-origin to the browser and sends
 * `Host: evil.com` with `Origin: http://evil.com` — an exact match, which
 * branch 4 alone would admit. `isHostAllowed` rejects the `Host`, and the
 * pairing is the same one `hostGuard` provides for requests. When the host
 * check is inert (login on, or the container escape hatch) branch 4 stands
 * alone, for the same reason `hostGuard` stands down there: auth cookies are
 * origin-scoped, so a rebound origin never presents one.
 *
 * @param facts - The resolved {@link UpgradeOriginFacts}.
 */
export function isTrustedUpgradeOrigin(facts: UpgradeOriginFacts): boolean {
  const { origin } = facts;
  if (!origin) return true;

  if (resolveTrustedOrigins().includes(origin)) return true;

  if (facts.publicUrl) {
    try {
      if (new URL(facts.publicUrl).origin === origin) return true;
    } catch {
      // A malformed DORKOS_PUBLIC_URL trusts nothing extra, rather than throwing
      // on the upgrade path.
    }
  }

  // An explicit `DORKOS_CORS_ORIGIN` list is exhaustive, exactly as it is in
  // `buildCors` — which switches to a static allowlist and drops its own
  // same-origin branch. Split and trimmed the same way, and the wildcard is
  // treated as no list at all (see the doc).
  const configured = facts.configuredOrigins;
  if (configured && configured !== '*') {
    return configured
      .split(',')
      .map((entry) => entry.trim())
      .includes(origin);
  }

  // Same-origin as this request, gated on the host allowlist (see the doc).
  if (!facts.hostAllowed && !facts.hostCheckInert) return false;
  const host = facts.hostHeader?.trim().toLowerCase();
  if (!host) return false;
  const candidate = origin.trim().toLowerCase();
  // An exact `<scheme>://<host>` comparison — NOT a hostname match. A browser
  // sends `Origin` already normalized (lower-cased, no path, no trailing
  // slash, no credentials), so anything that does not compare equal is not the
  // page this server served.
  const proto = facts.forwardedProto?.trim().toLowerCase().split(',')[0]?.trim();
  if (proto) return candidate === `${proto}://${host}`;
  // No proxy said which scheme it terminated, so either is accepted for the
  // SAME host and port. That latitude spans only http-vs-https on one
  // authority, which is not a boundary a page can cross by choosing a port.
  return candidate === `http://${host}` || candidate === `https://${host}`;
}
