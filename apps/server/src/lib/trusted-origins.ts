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
import { isIP, isIPv4 } from 'node:net';
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

/** The Vite dev-server port the cockpit is served from outside production. */
function viteDevPort(): string {
  // eslint-disable-next-line no-restricted-syntax -- VITE_PORT is a Vite-specific var not in server env.ts
  return process.env.VITE_PORT || '4241';
}

/**
 * The address a person's browser reaches THE COCKPIT at on this machine — which
 * is not always the API address, and that difference is the whole reason this
 * exists.
 *
 * In production the server serves the SPA itself, so the cockpit lives at
 * `DORKOS_PORT`. In development it does not: `express.static` is production-only,
 * nothing answers `/` on the API port, and the cockpit is on the Vite dev server.
 * A link built from `DORKOS_PORT` in dev is therefore dead exactly for the people
 * most likely to click it.
 *
 * The one spelling of "where DorkOS is", so a link back into the app (the OAuth
 * callback landing page) and the always-trusted loopback origins below can never
 * disagree. Both ports are derived, never hardcoded.
 */
export function getLocalCockpitOrigin(): string {
  const port = env.NODE_ENV === 'production' ? String(env.DORKOS_PORT) : viteDevPort();
  return `http://localhost:${port}`;
}

/**
 * Static loopback dev origins the server always trusts: `localhost` and
 * `127.0.0.1` on both the API port (`DORKOS_PORT`) and the Vite dev port
 * (`VITE_PORT`, default 4241).
 */
export function getStaticLocalOrigins(): string[] {
  const port = String(env.DORKOS_PORT);
  // The Vite dev-server origin is a DEVELOPMENT affordance: in dev the cockpit
  // is served from a different port than the API, so it is genuinely
  // cross-origin. In production the server serves the SPA itself, nothing
  // legitimate speaks from that port, and anything else that happened to listen
  // there would be trusted — which on the socket path now includes the terminal.
  if (env.NODE_ENV === 'production') {
    return [getLocalCockpitOrigin(), `http://127.0.0.1:${port}`];
  }
  const vitePort = viteDevPort();
  return [
    `http://localhost:${port}`,
    getLocalCockpitOrigin(),
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

/**
 * Parse `DORKOS_CORS_ORIGIN` — the operator's explicit allowlist — into the
 * origins it names.
 *
 * The ONE parser every surface that honours the variable reads: `buildCors` in
 * `app.ts`, branch 3 of {@link isTrustedUpgradeOrigin}, and
 * {@link resolveAuthTrustedOrigins}. Two copies of a split-and-trim are how a
 * padded `" * "` once meant the wildcard on one surface and a one-entry
 * allowlist on the next, which blacked out the app's own socket while HTTP kept
 * working. One parser cannot drift from itself.
 *
 * `*` parses to NO origins, on every surface. A wildcard is not an allowlist: it
 * would hand the whole API to any page the operator visits, and login is off by
 * default so nothing else would stop it. `buildCors` warns once when it sees
 * one; this is the half that makes the warning true.
 *
 * Entries are trimmed but otherwise passed through verbatim, including empty
 * ones, so a value that reaches CORS as a list of nothing still reads as a list
 * of nothing everywhere else.
 *
 * @param value - The raw `DORKOS_CORS_ORIGIN` value, or `undefined` when unset.
 * @returns The origins the operator named; `[]` when unset, blank, or `*`.
 */
export function parseConfiguredOrigins(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '*') return [];
  return trimmed.split(',').map((entry) => entry.trim());
}

/**
 * The origins Better Auth accepts on its CSRF allowlist: everything
 * {@link resolveTrustedOrigins} trusts, plus the origins the operator listed in
 * `DORKOS_CORS_ORIGIN`.
 *
 * ## Why the auth surface needs its own resolver
 *
 * Better Auth refuses any state-changing request whose `Origin` is not on this
 * list, so a surface the CORS layer already answers but this list does not know
 * gets an app where reading works, streaming works, and signing in is the one
 * thing that fails. That was DOR-1744: `pnpm dev:desktop` serves the renderer
 * from electron-vite's own port and hands the server that origin as
 * `DORKOS_CORS_ORIGIN`, so every REST call worked and the owner-setup dialog
 * died on `Invalid origin`, which blocks Remote Access setup outright. Branch 3
 * of {@link isTrustedUpgradeOrigin} settled the identical question for
 * WebSockets and for the same reason: a surface refusing what a request accepts
 * is a silent outage rather than an error anyone can read.
 *
 * ## Why NOT fold it into `resolveTrustedOrigins` itself
 *
 * Because `routes/extensions-approval.ts` reads that function and documents, at
 * length, that it does not consult `DORKOS_CORS_ORIGIN` on purpose: "which sites
 * may read my responses" is a different question from "which page may record a
 * person's security decision". Widening the shared function would answer the
 * second with the first silently. So the widening lives here, where the only
 * consumer is the CSRF check, and that deliberate exclusion stays intact.
 *
 * ## What is dropped, and why
 *
 * An entry Better Auth would read as a PATTERN rather than a literal origin.
 * Its `matchesOriginPattern` treats `*` and `?` as wildcards, so
 * `https://*.example.com` would trust every subdomain here while matching
 * nothing at all in CORS — the auth list would end up WIDER than the CORS list
 * it is meant to mirror. Blank entries go too: an origin nobody can send is
 * noise, and Better Auth falls back to a `startsWith` comparison for a
 * non-http(s) scheme, where an empty pattern matches everything.
 *
 * Resolved at call time (Better Auth takes a callback), so a tunnel that
 * connects after boot is trusted without a restart, exactly as before.
 */
export function resolveAuthTrustedOrigins(): string[] {
  const trusted = resolveTrustedOrigins();
  // eslint-disable-next-line no-restricted-syntax -- DORKOS_CORS_ORIGIN is not in env.ts; read the same way app.ts reads it
  const configured = parseConfiguredOrigins(process.env.DORKOS_CORS_ORIGIN).filter(
    (origin) =>
      origin.length > 0 &&
      !origin.includes('*') &&
      !origin.includes('?') &&
      !trusted.includes(origin)
  );
  return [...trusted, ...configured];
}

/** The facts {@link isTrustedUpgradeOrigin} decides on, all resolved by the caller. */
export interface UpgradeOriginFacts {
  /** The upgrade's `Origin` header. Absent for every non-browser client. */
  origin: string | undefined;
  /** The upgrade's raw `Host` header — what the caller asked for. */
  hostHeader: string | undefined;
  /** Whether this instance answers to that `Host` (`isHostAllowed`). */
  hostAllowed: boolean;
  /**
   * `DORKOS_ALLOW_INSECURE_BIND` — the deployment declares it owns its network
   * boundary. Here it does exactly one thing: it lets an **IP-literal** `Host`
   * satisfy the pairing. See {@link isTrustedUpgradeOrigin}.
   */
  ownsNetworkBoundary: boolean;
  /** `DORKOS_CORS_ORIGIN`, the operator's explicit allowlist (or `*`). */
  configuredOrigins: string | undefined;
  /**
   * `X-Forwarded-Proto`, when a proxy set it — the upgrade's equivalent of the
   * `trust proxy` that lets `req.protocol` see through Caddy or ngrok.
   *
   * Present, it pins the same-origin comparison to ONE scheme. Absent, the
   * comparison falls back to {@link connectionEncrypted} — this connection's own
   * encryption — rather than accepting both.
   */
  forwardedProto: string | undefined;
  /**
   * Whether the socket this upgrade arrived on is TLS-encrypted
   * (`req.socket.encrypted`). Consulted only when no `X-Forwarded-Proto` names
   * the scheme: it defaults the same-origin comparison to this connection's own
   * encryption — `https` when the socket is TLS, `http` otherwise — instead of
   * accepting both schemes. The server never terminates TLS itself (TLS is
   * always terminated by an upstream proxy), so in practice this is `false` and
   * the default is `http`, matching what `buildCors` pins on the HTTP path.
   */
  connectionEncrypted: boolean;
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
 * Whether a `Host` header names a bare IP address rather than a DNS name.
 *
 * This is the one thing `DORKOS_ALLOW_INSECURE_BIND` buys on the upgrade path,
 * and the reason it is safe to buy: a DNS-rebinding attack works by pointing a
 * NAME at this machine, so the `Host` it produces is always that name. It can
 * never be an IP literal, because a browser sends the address bar's authority
 * and typing an IP involves no DNS at all. So if `Origin` and `Host` are the
 * same IP literal AND the connection arrived here, the page was served by this
 * server — the port is part of the comparison, so a different service on the
 * same address does not match.
 *
 * That covers the deployment shape the flag exists for: the shipped container on
 * a NAS, homelab or VPS, browsed at `http://192.168.1.50:4242`. A NAME-based
 * address (`http://box.lan:4242`) is not covered and must be listed in
 * `DORKOS_TRUSTED_HOSTS` — which is what `docs/self-hosting/docker.mdx` now
 * says, because the alternative is a deployment where the app loads and no
 * stream ever connects.
 *
 * @param hostHeader - The raw `Host` header.
 */
function isIpLiteralHost(hostHeader: string | undefined): boolean {
  const hostname = parseHostname(hostHeader);
  return hostname !== null && isIP(hostname) !== 0;
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
 * 0. **`Origin: null`** — refused, always, before anything else. That is what a
 *    browser sends from a sandboxed iframe, a `data:` document or a `file://`
 *    page: an OPAQUE origin, which is precisely "an origin that should be
 *    trusted with nothing". It is listed first because it is the value most
 *    likely to slip through a comparison written for real origins — `URL.origin`
 *    serializes an unparseable URL to the literal string `"null"`, so any branch
 *    built from operator config could hand it a match. One did (see below).
 * 1. **No `Origin` at all** — a non-browser client (CLI, tests, the desktop
 *    shell). Passes, like the CORS delegate and `validateMcpOrigin`: a header a
 *    browser is forced to send truthfully proves nothing by its absence. Note
 *    this is ABSENT, not `null`; the two are opposites here.
 * 2. **A statically trusted origin** — loopback dev origins, the live tunnel.
 * 3. **A name in `DORKOS_CORS_ORIGIN`** — the operator's explicit list, which
 *    the HTTP path already honours; a socket refusing what a request accepts is
 *    the inconsistency that made this a silent outage rather than an error
 *    somebody could read. When set, it makes branch 4 unreachable, as it does
 *    in `buildCors`. It is NOT the whole policy the way `buildCors`'s static
 *    list is: branch 2 sits above it, so the loopback dev origins and a live
 *    tunnel still pass. That is deliberate — locking the operator out of
 *    `localhost` for setting a production allowlist would be an outage, not a
 *    boundary — but it means "exhaustive" is the wrong word and this is
 *    marginally wider than CORS in that one respect.
 *
 *    **`DORKOS_PUBLIC_URL` is deliberately NOT consulted**, and its removal is
 *    the fourth hole this function has had. It is documented as the address to
 *    advertise on agent cards, it is unvalidated, and as a trust branch it both
 *    outranked the operator's explicit `DORKOS_CORS_ORIGIN` list and was never
 *    paired with `Host`. `DORKOS_PUBLIC_URL=dorkos:4242` — a plausible typo, and
 *    a shape the reverse-proxy docs sit next to — parses with `dorkos:` as the
 *    SCHEME and serializes to origin `"null"`, so ANY sandboxed iframe or
 *    `file://` page that could reach the port was handed the terminal. An
 *    operator who needs a name has `DORKOS_TRUSTED_HOSTS`, which the proxy docs
 *    already tell them to set and which feeds the PAIRED branch below.
 *
 *    **`DORKOS_CORS_ORIGIN='*'` is not honoured**, and since 2026-09 that is
 *    no longer a place this is stricter than CORS — `buildCors` now ignores the
 *    wildcard too, for the reason this branch always had. The old argument for
 *    honouring it on HTTP was that a wildcard `Access-Control-Allow-Origin` is
 *    invalid for credentialed requests, so browsers reject it whatever the
 *    server says; that covers only the credentialed case, and login is off by
 *    default, so the wildcard handed the whole API to any page the operator
 *    visited. A WebSocket handshake never had even that backstop: cookies
 *    attach automatically and there is no ACAO to reject. Both surfaces now
 *    treat the wildcard as "no list", so the other branches still decide, and
 *    both trim the value first so a padded `" * "` cannot mean one thing here
 *    and another there.
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
 * it, the scheme defaults to this connection's OWN encryption — `https` when the
 * socket is TLS, `http` otherwise — the same single scheme `buildCors` pins on
 * the HTTP path, where `req.protocol` is the forwarded scheme when a proxy names
 * one and `http` otherwise. Because the server never terminates TLS itself
 * (`index.ts` binds plain HTTP; a proxy always terminates upstream), a bare
 * socket resolves to `http`, so only `http://<host>` is accepted. That closes
 * the widening an accept-either fallback would leave open: `http://example.com`
 * is port 80 and `https://example.com` is 443, which are different servers, so
 * accepting both would let a script on the **plaintext** vhost of that name
 * match a secure cockpit of the same name. The nginx and Caddy configs this repo
 * ships both set `X-Forwarded-Proto`, so the scheme is pinned there; a custom
 * proxy that forwards neither the scheme nor a trusted host now resolves to
 * `http`, fail-closed. Forging the header cannot widen anything — supplying it
 * only replaces the connection default with a single equality.
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
  // ABSENT means a non-browser client and passes; the literal `null` is an
  // OPAQUE origin (sandboxed iframe, `data:`, `file://`) and is refused outright.
  // They read alike and mean opposite things.
  if (origin === undefined) return true;
  if (origin === '' || origin.trim().toLowerCase() === 'null') return false;

  if (resolveTrustedOrigins().includes(origin)) return true;

  // An explicit `DORKOS_CORS_ORIGIN` list makes branch 4 unreachable, as it does
  // in `buildCors` — which switches to a static allowlist and drops its own
  // same-origin branch. Read through the shared {@link parseConfiguredOrigins},
  // which is also what `buildCors` and Better Auth's allowlist read, so the same
  // value cannot mean different things on the three surfaces that honour it.
  const configured = parseConfiguredOrigins(facts.configuredOrigins);
  if (configured.length > 0) return configured.includes(origin);

  // Same-origin as this request, gated on the host allowlist (see the doc).
  // A deployment that owns its network boundary additionally satisfies the
  // pairing with an IP-LITERAL Host, which a rebinding attack cannot produce.
  const pairingHolds =
    facts.hostAllowed ||
    facts.hostCheckInert ||
    (facts.ownsNetworkBoundary && isIpLiteralHost(facts.hostHeader));
  if (!pairingHolds) return false;
  const host = facts.hostHeader?.trim().toLowerCase();
  if (!host) return false;
  const candidate = origin.trim().toLowerCase();
  // An exact `<scheme>://<host>` comparison — NOT a hostname match. A browser
  // sends `Origin` already normalized (lower-cased, no path, no trailing
  // slash, no credentials), so anything that does not compare equal is not the
  // page this server served.
  // The scheme, pinned. A proxy that named it (`X-Forwarded-Proto`) wins;
  // otherwise default to this connection's own encryption — `http` for the plain
  // socket the server always binds, since TLS is terminated upstream. That is
  // the scheme `buildCors` pins on the HTTP path, and it is a single equality,
  // not the accept-either that once widened the reverse-proxy case: `http://` and
  // `https://` on one name are different servers, so accepting both let a page on
  // the plaintext vhost of that name match a secure cockpit.
  const proto =
    facts.forwardedProto?.trim().toLowerCase().split(',')[0]?.trim() ??
    (facts.connectionEncrypted ? 'https' : 'http');
  return candidate === `${proto}://${host}`;
}
