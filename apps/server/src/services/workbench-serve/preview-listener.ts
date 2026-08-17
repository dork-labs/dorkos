/**
 * A dedicated origin for every dev server the embedded browser previews
 * (DOR-1260, ADR 260817-152705).
 *
 * ## Why an origin and not a path
 *
 * The old preview served a dev server under `/api/workbench/proxy/<token>/`, and
 * that cannot work for any real app: a page whose HTML asks for `/main.js` asks
 * the COCKPIT for `/main.js`, a client-side router reads the token path as its
 * route, and a live-reload socket connects to the wrong place. So each target
 * port gets its own HTTP listener on its own port, and the frame's origin root
 * IS the app root. Root-absolute assets, routers and HMR then need nothing
 * special: they are simply correct.
 *
 * The listener binds the same interface the main server binds, so a cockpit
 * reached over the LAN or Tailscale reaches the preview too — which is the whole
 * point, since `localhost` on the viewer's phone is the phone.
 *
 * ## What stands between the network and 127.0.0.1
 *
 * That reach cuts both ways: the listener is as exposed as DorkOS itself, and
 * behind it sits a loopback service that expects only local callers. The cookie
 * is the only thing in between, so it is treated as the security boundary it is:
 *
 * - Nothing is proxied without a valid token. Not one byte reaches the dev
 *   server before the signature, the expiry and the target port all check out.
 * - The token arrives once, in the bootstrap URL, and is immediately moved into
 *   an `HttpOnly` cookie and redirected out of the address bar (with
 *   `Referrer-Policy: no-referrer`, so it cannot leak onward as a `Referer`).
 * - The cookie is named for the LISTEN port, because cookies on one host are
 *   shared across ports — two open previews must not overwrite each other's
 *   authorization, nor be able to use it.
 * - `/__dorkos_preview/health` is the one unauthenticated route, and it answers
 *   `204` and nothing else. It exists so the browser can ask "can I reach this
 *   origin at all" before framing it; it never touches the dev server.
 * - DorkOS's own cookies are never forwarded upstream (see
 *   {@link filterOutboundCookies}), and the token is never written to a log.
 *
 * @module services/workbench-serve/preview-listener
 */
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WORKBENCH } from '../../config/constants.js';
import { logger as defaultLogger } from '../../lib/logger.js';
import { injectDevtoolsScript } from './devtools-inject.js';
import {
  filterInboundSetCookies,
  filterOutboundCookies,
  isUtf8OrUnspecified,
  readCookie,
  STRIPPED_REQUEST_HEADERS,
  STRIPPED_RESPONSE_HEADERS,
  stripFrameAncestors,
} from './proxy-headers.js';
import { workbenchTokenSigner, WorkbenchTokenError, type WorkbenchTokenSigner } from './token.js';
import { env } from '../../env.js';

/** The query parameter that carries the signed token on a bootstrap request. */
export const PREVIEW_BOOTSTRAP_PARAM = '__dorkos_preview';

/** The unauthenticated reachability endpoint. Answers 204; never proxies. */
export const PREVIEW_HEALTH_PATH = '/__dorkos_preview/health';

/** The loopback addresses a dev server may be bound to, tried in this order. */
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'] as const;

/** How long to wait for a loopback connection when picking the upstream address. */
const ADDRESS_PICK_TIMEOUT_MS = 500;

/** An open preview listener: the dev server it fronts, and the port it answers on. */
export interface PreviewOrigin {
  /** The dev-server port on this machine being previewed. */
  targetPort: number;
  /** The port the preview listener answers on. */
  listenPort: number;
}

/** Thrown by {@link PreviewListenerManager.acquire} when no port is free. */
export class PreviewPortExhaustedError extends Error {
  constructor(range: { from: number; to: number }) {
    super(`No free preview port in ${range.from}-${range.to}`);
    this.name = 'PreviewPortExhaustedError';
  }
}

/** The logging surface the manager uses; injectable so a test can read it. */
export interface PreviewLogger {
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  /** Optional: socket-level noise, which is normal and not worth an operator's attention. */
  debug?: (message: string, data?: unknown) => void;
}

/** How to construct a {@link PreviewListenerManager}. */
export interface PreviewListenerOptions {
  /** The interface to bind, normally `env.DORKOS_HOST`. */
  host: string;
  /** Verifies the bootstrap tokens; the same signer that minted them. */
  signer: WorkbenchTokenSigner;
  /** Close a listener after this long with no requests. */
  idleTtlMs?: number;
  /**
   * Bind within this inclusive port range instead of letting the OS choose, so
   * a Docker or `ssh -L` operator can forward a known set of ports.
   */
  portRange?: { from: number; to: number } | null;
  /** How long to wait for the dev server to answer before giving up. */
  upstreamTimeoutMs?: number;
  logger?: PreviewLogger;
}

/** One live listener and the bookkeeping that decides when to close it. */
interface Entry {
  server: http.Server;
  listenPort: number;
  lastUsedAt: number;
  reaper: NodeJS.Timeout | null;
  /** The loopback address the dev server actually answered on, once known. */
  upstreamHost: string | null;
  /**
   * Every socket this listener has taken over through an `upgrade`, on both
   * sides of the pipe.
   *
   * Tracked because an upgraded socket stops being the HTTP server's problem the
   * moment it is handed over: `closeAllConnections()` does not touch it, so
   * `server.close()` waits for it forever — and a live WebSocket is the ordinary
   * case here, because Vite's live reload holds one. It is also what tells the
   * idle reaper that a quiet preview is still in use.
   */
  sockets: Set<Duplex>;
  /** Set once {@link PreviewListenerManager.close} has claimed this entry. */
  closed: boolean;
}

/** A small HTML page — the only body this listener ever writes itself. */
function errorPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:14px system-ui;padding:2rem;color:#444"><p>${body}</p></body></html>`;
}

/** Answer with a small HTML page and no cache. */
function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/** Whether a loopback address accepts a connection on `port`. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(ADDRESS_PICK_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Opens, reuses and reaps one preview listener per dev-server port.
 *
 * See the module documentation for the authorization model — the short version
 * is that this class binds a network-reachable port in front of a loopback-only
 * service, and the signed cookie is the whole of what keeps the two apart.
 */
export class PreviewListenerManager {
  readonly #host: string;
  readonly #signer: WorkbenchTokenSigner;
  readonly #idleTtlMs: number;
  readonly #portRange: { from: number; to: number } | null;
  readonly #upstreamTimeoutMs: number;
  readonly #logger: PreviewLogger;
  readonly #entries = new Map<number, Entry>();
  readonly #opening = new Map<number, Promise<PreviewOrigin>>();

  constructor(options: PreviewListenerOptions) {
    this.#host = options.host;
    this.#signer = options.signer;
    this.#idleTtlMs = options.idleTtlMs ?? WORKBENCH.PREVIEW_IDLE_TTL_MS;
    this.#portRange = options.portRange ?? null;
    this.#upstreamTimeoutMs = options.upstreamTimeoutMs ?? WORKBENCH.PROXY_TIMEOUT_MS;
    this.#logger = options.logger ?? defaultLogger;
  }

  /**
   * The listener fronting `targetPort`, opening one if none is live.
   *
   * Concurrent callers for the same target share one opening attempt, so two
   * previews of the same dev server are one listener, not a race.
   *
   * @param targetPort - The dev-server port to front.
   * @returns The target and the port its listener answers on.
   * @throws PreviewPortExhaustedError when a configured port range is full.
   */
  async acquire(targetPort: number): Promise<PreviewOrigin> {
    const live = this.#entries.get(targetPort);
    if (live) {
      this.#touch(live);
      return { targetPort, listenPort: live.listenPort };
    }
    const inFlight = this.#opening.get(targetPort);
    if (inFlight) return inFlight;

    const opening = this.#open(targetPort).finally(() => this.#opening.delete(targetPort));
    this.#opening.set(targetPort, opening);
    return opening;
  }

  /**
   * Close one listener, or all of them.
   *
   * @param targetPort - The dev-server port whose listener to close; omit for all.
   */
  async close(targetPort?: number): Promise<void> {
    const targets = targetPort === undefined ? [...this.#entries.keys()] : [targetPort];
    await Promise.all(targets.map((port) => this.#closeEntry(port)));
  }

  async #closeEntry(targetPort: number): Promise<void> {
    const entry = this.#entries.get(targetPort);
    if (!entry) return;
    this.#entries.delete(targetPort);
    entry.closed = true;
    if (entry.reaper) clearTimeout(entry.reaper);
    entry.reaper = null;
    entry.server.closeAllConnections();
    // Upgraded sockets are NOT connections the server still counts as its own,
    // and `server.close()` waits for every one of them. Left alone, a single
    // open live-reload socket makes this await hang — and this runs near the top
    // of the server's shutdown, so everything after it would never happen.
    for (const socket of entry.sockets) socket.destroy();
    entry.sockets.clear();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
    this.#logger.info('[workbench-preview] closed', {
      targetPort,
      listenPort: entry.listenPort,
    });
  }

  async #open(targetPort: number): Promise<PreviewOrigin> {
    const server = http.createServer();
    const entry: Entry = {
      server,
      listenPort: 0,
      lastUsedAt: Date.now(),
      reaper: null,
      upstreamHost: null,
      sockets: new Set(),
      closed: false,
    };
    server.on('request', (req, res) => {
      void this.#handleRequest(entry, targetPort, req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      void this.#handleUpgrade(entry, targetPort, req, socket, head);
    });

    entry.listenPort = await this.#listen(server);
    this.#entries.set(targetPort, entry);
    this.#touch(entry);
    this.#logger.info('[workbench-preview] opened', {
      targetPort,
      listenPort: entry.listenPort,
      host: this.#host,
    });
    return { targetPort, listenPort: entry.listenPort };
  }

  /** Bind the OS-chosen port, or the first free port in the configured range. */
  async #listen(server: http.Server): Promise<number> {
    const candidates: number[] = [];
    if (this.#portRange) {
      for (let port = this.#portRange.from; port <= this.#portRange.to; port++) {
        candidates.push(port);
      }
    } else {
      candidates.push(0);
    }
    for (const candidate of candidates) {
      const bound = await new Promise<number | null>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          server.removeListener('listening', onListening);
          if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(null);
          else reject(err);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          resolve((server.address() as AddressInfo).port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, this.#host);
      });
      if (bound !== null) return bound;
    }
    throw new PreviewPortExhaustedError(this.#portRange as { from: number; to: number });
  }

  /** Mark a listener used and restart its idle clock. */
  #touch(entry: Entry): void {
    entry.lastUsedAt = Date.now();
    this.#scheduleReap(entry);
  }

  /**
   * Arm the idle check, and re-arm it while the listener is still in use.
   *
   * "In use" is two things, and the second is the one that is easy to get wrong:
   * a recent request, OR an open upgraded socket. A live-reload socket can sit
   * connected and silent for hours — it is a preview someone still has open, and
   * closing its origin out from under it leaves a page whose HMR works while
   * every image, chunk and reload is refused.
   */
  #scheduleReap(entry: Entry): void {
    if (entry.closed) return;
    if (entry.reaper) clearTimeout(entry.reaper);
    entry.reaper = setTimeout(() => {
      entry.reaper = null;
      if (entry.sockets.size > 0 || Date.now() - entry.lastUsedAt < this.#idleTtlMs) {
        this.#scheduleReap(entry);
        return;
      }
      const targetPort = [...this.#entries.entries()].find(([, e]) => e === entry)?.[0];
      if (targetPort !== undefined) void this.#closeEntry(targetPort);
    }, this.#idleTtlMs);
    entry.reaper.unref();
  }

  /**
   * Adopt a socket taken over by an upgrade: never let its errors escape, keep
   * it out of the idle reaper's way, and let go of it when it closes.
   *
   * The error listener is why this exists. On `upgrade`, Node hands the socket
   * over and removes its OWN error handling from it, so an `'error'` with no
   * listener is an uncaught exception — and this server exits the process on
   * one. A client that resets the connection mid-handshake would take DorkOS
   * down with it, from anywhere on the network the listener is reachable, with
   * no cookie and no login.
   */
  #adoptSocket(entry: Entry, socket: Duplex, label: string): void {
    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.#logger.debug?.('[workbench-preview] socket error', { label, code: err.code });
      socket.destroy();
    });
    entry.sockets.add(socket);
    socket.once('close', () => {
      entry.sockets.delete(socket);
      // The idle clock starts when the last socket lets go, not when it was
      // opened — otherwise a preview closed after an hour would be reaped
      // immediately, and one opened an hour ago would never be.
      if (entry.sockets.size === 0) this.#touch(entry);
    });
  }

  /** Verify a token and confirm it authorizes exactly this target port. */
  #authorizes(token: string | null, targetPort: number): boolean {
    if (!token) return false;
    try {
      const payload = this.#signer.verify(token);
      return payload.scope.kind === 'proxy' && payload.scope.port === targetPort;
    } catch (err) {
      // Fail closed on ANYTHING, not just the expected rejection. Both callers
      // are fire-and-forget (`void this.#handle…()`), so a thrown error that is
      // not a `WorkbenchTokenError` — a future change inside `verify`, a bad
      // input shape — would become an unhandled rejection and leave the request
      // hanging with no answer at all, instead of a clean 401.
      if (!(err instanceof WorkbenchTokenError)) {
        this.#logger.warn('[workbench-preview] token verification failed unexpectedly', {
          targetPort,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
      return false;
    }
  }

  async #handleRequest(
    entry: Entry,
    targetPort: number,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    this.#touch(entry);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${entry.listenPort}`);

    // The one route that answers without a cookie — and it answers nothing but
    // "something is here", so it is safe to leave open.
    if (url.pathname === PREVIEW_HEALTH_PATH) {
      res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      return;
    }

    const bootstrap = url.searchParams.get(PREVIEW_BOOTSTRAP_PARAM);
    if (bootstrap !== null) {
      if (!this.#authorizes(bootstrap, targetPort)) return this.#refuse(res);
      url.searchParams.delete(PREVIEW_BOOTSTRAP_PARAM);
      const destination = `${url.pathname}${url.search}`;
      res.writeHead(302, {
        // Named for the listen port: cookies are shared across ports on one
        // host, so a second preview must not overwrite this one's authorization.
        // `HttpOnly` keeps it away from the previewed page's own scripts. No
        // `Secure`: this listener speaks plain HTTP by construction, and a
        // `Secure` cookie would simply never be sent back.
        'Set-Cookie': `${previewCookieName(entry.listenPort)}=${bootstrap}; Path=/; HttpOnly; SameSite=Lax`,
        Location: destination,
        // The token is in the URL this redirect leaves behind — never let it
        // ride onward as a `Referer`.
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    const cookie = readCookie(req.headers.cookie, previewCookieName(entry.listenPort));
    if (!this.#authorizes(cookie, targetPort)) return this.#refuse(res);

    await this.#proxy(entry, targetPort, req, res);
  }

  /** The only answer an unauthorized request ever gets. Never proxies. */
  #refuse(res: http.ServerResponse): void {
    sendHtml(
      res,
      401,
      errorPage(
        'Preview expired',
        'This preview link has expired. Reload the canvas to open a fresh one.'
      )
    );
  }

  /** The loopback address the dev server answers on, remembered between requests. */
  async #upstreamHost(entry: Entry, targetPort: number): Promise<string> {
    if (entry.upstreamHost) return entry.upstreamHost;
    // A dev server told to bind `localhost` may land on `::1` alone, and a
    // proxy that only ever dials `127.0.0.1` would report it as missing. Both
    // candidates are literal loopback addresses, so nothing here can be aimed
    // off this machine.
    for (const host of LOOPBACK_ADDRESSES) {
      if (await accepts(host, targetPort)) {
        entry.upstreamHost = host;
        return host;
      }
    }
    return LOOPBACK_ADDRESSES[0];
  }

  /** Request headers as the dev server should see them. */
  #upstreamHeaders(req: http.IncomingMessage, targetPort: number): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      if (value !== undefined) headers[key] = value;
    }
    // The dev server must see its own name: Vite's `server.allowedHosts` check
    // reads this, and a request claiming the cockpit's host is rejected.
    headers.host = `localhost:${targetPort}`;
    // Ask for an unencoded body so an HTML response can be decoded and
    // instrumented without a decompression step in the middle.
    headers['accept-encoding'] = 'identity';
    const cookie = filterOutboundCookies(req.headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    return headers;
  }

  async #proxy(
    entry: Entry,
    targetPort: number,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const host = await this.#upstreamHost(entry, targetPort);
    const upstream = http.request({
      host,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: this.#upstreamHeaders(req, targetPort),
    });

    upstream.setTimeout(this.#upstreamTimeoutMs, () => {
      upstream.destroy(new Error('timeout'));
      if (!res.headersSent) {
        sendHtml(
          res,
          504,
          errorPage('Preview timed out', 'The dev server did not answer in time.')
        );
      } else {
        res.destroy();
      }
    });

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH') {
        // Whatever address was remembered is no longer right — re-pick next time.
        entry.upstreamHost = null;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err.code === 'ECONNREFUSED') {
        sendHtml(
          res,
          502,
          errorPage('Nothing is listening', `Nothing is listening on localhost:${targetPort}.`)
        );
        return;
      }
      if (err.message === 'timeout') return;
      this.#logger.warn('[workbench-preview] upstream failed', { targetPort, code: err.code });
      sendHtml(res, 502, errorPage('Preview failed', 'The dev server could not be reached.'));
    });

    upstream.on('response', (upstreamRes) => this.#relay(upstreamRes, res, targetPort));
    req.pipe(upstream);
  }

  /** Relay an upstream response, unframed and instrumented. */
  #relay(upstreamRes: http.IncomingMessage, res: http.ServerResponse, targetPort: number): void {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      const lower = key.toLowerCase();
      if (STRIPPED_RESPONSE_HEADERS.has(lower) || value === undefined) continue;
      if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
        const sanitized = stripFrameAncestors(String(value));
        if (sanitized) headers[key] = sanitized;
        continue;
      }
      if (lower === 'location') {
        headers[key] = rewriteUpstreamLocation(String(value), targetPort);
        continue;
      }
      if (lower === 'set-cookie') {
        // A dev server may set its own cookies, and must not set DorkOS's — a
        // preview origin is a different port on the SAME host as the cockpit,
        // and cookies are not scoped by port. Kept as an array so several
        // cookies stay several headers.
        const relayed = filterInboundSetCookies(value);
        if (relayed.length > 0) headers[key] = relayed;
        continue;
      }
      headers[key] = value;
    }

    const contentType = upstreamRes.headers['content-type'];
    const instrumentable =
      typeof contentType === 'string' &&
      contentType.includes('text/html') &&
      isUtf8OrUnspecified(contentType);

    if (!instrumentable) {
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
      return;
    }

    // Buffer the (small) HTML so the DevTools shim can be its first head child.
    // The charset is restated because the ~9 KB shim can push a page's own
    // `<meta charset>` past the browser's 1024-byte prescan window.
    //
    // Bounded, because "an HTML response" is whatever the dev server says it is:
    // a generated report or a data-URI-heavy build artifact can be enormous, and
    // an unbounded concat would hold all of it in the server's memory. Past the
    // cap the response relays uninstrumented instead — the same disclosed
    // degradation a non-UTF-8 page already gets, for the same reason: better an
    // honest un-instrumented page than a proxy that falls over on a big one.
    const chunks: Buffer[] = [];
    let buffered = 0;
    let overflowed = false;
    upstreamRes.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      buffered += chunk.length;
      if (buffered > WORKBENCH.PREVIEW_HTML_INJECT_MAX_BYTES) {
        overflowed = true;
        this.#logger.warn('[workbench-preview] HTML too large to instrument', {
          targetPort,
          bytes: buffered,
        });
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        for (const pending of chunks) res.write(pending);
        chunks.length = 0;
        res.write(chunk);
        upstreamRes.pipe(res);
        return;
      }
      chunks.push(chunk);
    });
    upstreamRes.on('end', () => {
      if (overflowed) return;
      const injected = injectDevtoolsScript(Buffer.concat(chunks).toString('utf8'));
      headers['content-type'] = 'text/html; charset=utf-8';
      headers['content-length'] = Buffer.byteLength(injected);
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      res.end(injected);
    });
    upstreamRes.on('error', () => res.destroy());
  }

  /**
   * Pipe a WebSocket (or any other) upgrade through to the dev server, so live
   * reload works inside the preview exactly as it does in a browser tab.
   */
  async #handleUpgrade(
    entry: Entry,
    targetPort: number,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    // FIRST, before the cookie check and before anything that awaits: an
    // unguarded socket is a way to stop this whole process from the network.
    this.#adoptSocket(entry, socket, 'client');
    this.#touch(entry);
    const cookie = readCookie(req.headers.cookie, previewCookieName(entry.listenPort));
    if (!this.#authorizes(cookie, targetPort)) {
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n', () =>
          socket.destroy()
        );
      }
      return;
    }

    const host = await this.#upstreamHost(entry, targetPort);
    if (socket.destroyed) return;
    const headers = this.#upstreamHeaders(req, targetPort);
    // An upgrade is defined by the two hop-by-hop headers the proxy strips
    // everywhere else, so they are put back for this one request.
    headers.connection = req.headers.connection ?? 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';

    const upstream = http.request({
      host,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    });
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      // Guarded before a single byte is written to either side, for the same
      // reason the client socket is.
      this.#adoptSocket(entry, upstreamSocket, 'upstream');
      upstreamSocket.once('close', () => socket.destroy());
      socket.once('close', () => upstreamSocket.destroy());
      if (socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      const lines = [
        `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}`.trim(),
      ];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    if (head?.length) socket.unshift(head);
    upstream.end();
  }
}

/**
 * The cookie a preview listener authorizes itself with.
 *
 * Named for the LISTEN port, not the target: cookies are shared across every
 * port of one host, so two previews open at once would otherwise take turns
 * clobbering a single name — and each would be able to spend the other's
 * authorization.
 *
 * @param listenPort - The port the preview listener answers on.
 * @returns The cookie name for that listener.
 */
export function previewCookieName(listenPort: number): string {
  return `dorkos_preview_${listenPort}`;
}

/**
 * Keep a redirect inside the preview origin.
 *
 * A dev server that redirects (a missing trailing slash, an auth bounce) often
 * answers with its OWN absolute address. Following that would take the frame off
 * the preview origin and back to `localhost:<target>`, which is the very address
 * a phone or another laptop cannot reach. Only the dev server's own address is
 * rewritten, and only into a path — anything else is passed through untouched,
 * because a redirect somewhere genuinely else is the page's business.
 *
 * @param location - The upstream `Location` header.
 * @param targetPort - The dev-server port this listener fronts.
 * @returns The `Location` to send to the browser.
 */
export function rewriteUpstreamLocation(location: string, targetPort: number): string {
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    return location; // Already relative — resolves against the preview origin.
  }
  const isOwnAddress =
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname) &&
    parsed.port === String(targetPort);
  return isOwnAddress ? `${parsed.pathname}${parsed.search}${parsed.hash}` : location;
}

/**
 * The process-wide preview listeners, bound to the same interface the main
 * server binds so every device that can reach DorkOS can reach a preview.
 * Closed on shutdown (see `index.ts`).
 */
export const previewListeners = new PreviewListenerManager({
  host: env.DORKOS_HOST,
  signer: workbenchTokenSigner,
  portRange: env.DORKOS_PREVIEW_PORT_RANGE ?? null,
});
