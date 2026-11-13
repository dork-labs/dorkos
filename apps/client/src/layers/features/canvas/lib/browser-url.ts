/**
 * The browser renders three kinds of target, each routed differently:
 * - `external` — an arbitrary `http(s)` site, framed directly (and falling back
 *   to the system browser when the site refuses embedding).
 * - `proxy` — a `localhost`/loopback dev server. Framed on a preview origin
 *   DorkOS opens for it, and — when that origin cannot be reached but this page
 *   is open on the same machine — by its own address instead
 *   (see {@link loopbackStrategy}).
 * - `serve` — a local file within the session cwd, routed through the signed
 *   static-serve route so relative assets resolve.
 *
 * Local files render in an opaque-origin sandbox (WITHOUT `allow-same-origin`)
 * so untrusted local HTML can never call `/api/*` as the user. External sites —
 * and a dev server, on whichever origin it ends up — keep `allow-same-origin`:
 * they live on their own origin, so it grants them nothing against the DorkOS
 * origin.
 *
 * @module features/canvas/lib/browser-url
 */

/**
 * Sandbox tokens for served/proxied (untrusted, same-serving-origin) content.
 * `allow-same-origin` is intentionally ABSENT — the frame gets an opaque origin
 * and cannot reach the DorkOS session, cookies, or `/api/*`. Mirrors the
 * mcp-apps posture (`mcp-apps/lib/sandbox.ts`) for a different threat model.
 */
export const WORKBENCH_SANDBOX_ISOLATED = 'allow-scripts allow-forms allow-popups allow-modals';

/**
 * Sandbox tokens for external sites, which live on their own origin. Granting
 * `allow-same-origin` lets them function normally and gives them nothing against
 * the DorkOS origin (they are cross-origin to it regardless).
 */
export const WORKBENCH_SANDBOX_EXTERNAL =
  'allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-downloads';

/** Protocols never loaded in the browser frame (script/URI-smuggling vectors). */
const BLOCKED_PROTOCOLS = new Set(['javascript:', 'data:', 'blob:']);

/**
 * Hostnames treated as loopback (routed through the localhost proxy).
 *
 * `0.0.0.0` is in this set on purpose, and the server's `trusted-origins.ts`
 * deliberately treats it as public — the two are answering different questions.
 * The server is asked "may a request claiming this origin be trusted", where
 * `0.0.0.0` means every interface and so cannot be vouched for. Here the question
 * is "where will this page's browser go if it loads this URL", and a browser
 * pointed at `0.0.0.0` goes to the machine it is running on. Same string,
 * opposite meaning, both correct.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/** A classified browser target. */
export type BrowserTarget =
  | { mode: 'external'; url: string }
  | { mode: 'proxy'; hostname: string; port: number; path: string }
  | { mode: 'serve'; path: string }
  | { mode: 'blocked' };

/**
 * Whether a URL's hostname is a loopback address. A trailing dot (`localhost.`)
 * names the same host, so it is read the same.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = withoutTrailingDot(hostname);
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

/** A hostname with its one trailing dot, if any, removed: `a.example.` names `a.example`. */
function withoutTrailingDot(hostname: string): string {
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

/** The parts of the page's own `Location` {@link isThisAppsAddress} reads. */
export interface PageAddress {
  /** The page's origin, e.g. `http://localhost:4242`. */
  origin: string;
  /** The page's hostname, e.g. `localhost`. */
  hostname: string;
  /** The page's port as `Location` reports it (`''` for the scheme's default). */
  port: string;
  /** The page's scheme with its colon, e.g. `http:`. */
  protocol: string;
}

/**
 * Whether a frame source is this app's own server, so framing it with
 * `allow-same-origin` would hand the framed page the app's own powers.
 *
 * Three shapes count. The page's exact origin, which a tunnel or Wi-Fi address
 * reaches as an `external` target. Any of the server's own other addresses
 * (`ownOrigins`: its tunnel, Wi-Fi and hub origins, from the server's config),
 * which a page open on `localhost` would otherwise read as a stranger's (DOR-4132).
 * And, while the page is on a loopback name, any loopback name on the page's own
 * port: `127.0.0.1:4242` is a different origin string from `localhost:4242` but
 * the same server, and the server trusts both. A trailing dot on the source's
 * host names the same host and is ignored. A source that does not parse is
 * treated as this app's, since a relative URL resolves onto the page's own origin.
 *
 * @param src - The URL about to be framed (absolute, or relative to the page).
 * @param page - The page rendering the frame, normally `window.location`.
 * @param ownOrigins - The server's own other origins, as `GET /api/config` reports them.
 */
export function isThisAppsAddress(
  src: string,
  page: PageAddress,
  ownOrigins: readonly string[] = []
): boolean {
  let target: URL;
  try {
    target = new URL(src, page.origin);
  } catch {
    return true;
  }
  target.hostname = withoutTrailingDot(target.hostname);
  if (target.origin === page.origin) return true;
  if (ownOrigins.some((origin) => sameOrigin(origin, target.origin))) return true;
  if (!isLoopbackHost(page.hostname) || !isLoopbackHost(target.hostname)) return false;
  const pagePort = page.port || String(defaultPort(page.protocol));
  const targetPort = target.port || String(defaultPort(target.protocol));
  return pagePort === targetPort;
}

/** Whether a configured origin names `origin`. One that does not parse names nothing. */
function sameOrigin(configured: string, origin: string): boolean {
  try {
    const parsed = new URL(configured);
    parsed.hostname = withoutTrailingDot(parsed.hostname);
    return parsed.origin === origin;
  } catch {
    return false;
  }
}

/** How a loopback (`proxy`) target is loaded: straight into the frame, or via the server. */
export type LoopbackStrategy = 'direct' | 'server';

/**
 * Decide how a loopback dev server should be loaded, from the hostname of the
 * page asking.
 *
 * `localhost` names whichever machine is looking at the page. So a dev server
 * can be framed by its own address only when the cockpit is open ON the machine
 * running it — the browser then resolves `localhost:5173` to the same server the
 * user started. Open the same cockpit from a phone over Tailscale and
 * `localhost` is the phone, which is running nothing.
 *
 * This is the FALLBACK, not the first choice: a preview origin works from any
 * device that can reach DorkOS and carries the DevTools shim, so it is tried
 * first. This answer only decides whether there is anything left to try when
 * that origin turns out to be unreachable — which is the case where DorkOS runs
 * in a container or behind `ssh -L` and its preview port was never forwarded.
 *
 * Either way the frame gets {@link WORKBENCH_SANDBOX_EXTERNAL}, and that is not
 * a loosening: the origin is `http://<host>:<port>`, cross-origin to the cockpit
 * and absent from the server's trusted origins, so it cannot read `/api/*`. It
 * is exactly as privileged as the same dev server open in another browser tab.
 * The one address that premise fails for is this app's own, which
 * {@link isThisAppsAddress} catches before any frame is published.
 * The `serve` path — local files on the DorkOS origin, where the untrusted-HTML
 * threat actually lives — keeps its opaque origin.
 *
 * @param pageHostname - `window.location.hostname` of the page rendering the frame.
 * @returns Whether to frame the dev server's own URL or route it via the server.
 */
export function loopbackStrategy(pageHostname: string): LoopbackStrategy {
  return isLoopbackHost(pageHostname) ? 'direct' : 'server';
}

/**
 * Put the page the user actually asked for onto the preview origin.
 *
 * The server hands back a bootstrap URL for the origin's root — `http://host:
 * 4243/?__dorkos_preview=<token>` — because the token, not the path, is what it
 * is answering about. But someone who opened `/projects/promo/edit` should land
 * there, not on the app's home page, so the logical path is spliced in and the
 * token rides along behind it. The listener checks the token, sets its cookie,
 * and redirects to the same path without it.
 *
 * @param bootstrapUrl - The URL the server minted for the preview origin.
 * @param logicalPath - The path (and query) of the target, e.g. `/some/route?a=1`.
 * @returns The URL to frame, or `null` when the bootstrap URL is unparsable.
 */
export function splicePreviewPath(bootstrapUrl: string, logicalPath: string): string | null {
  let minted: URL;
  try {
    minted = new URL(bootstrapUrl);
  } catch {
    return null;
  }
  const token = minted.searchParams.get(PREVIEW_BOOTSTRAP_PARAM);
  // Built by SETTING the components, never by resolving `logicalPath` against
  // the origin. A path is allowed to begin with `//` — `http://localhost:5178//
  // evil.example.com/x` classifies with exactly that path — and resolving one
  // would read it as protocol-relative and leave the preview origin for a host
  // of the page's choosing. The setters cannot do that.
  const target = new URL(minted.origin);
  const queryAt = logicalPath.indexOf('?');
  target.pathname = (queryAt === -1 ? logicalPath : logicalPath.slice(0, queryAt)) || '/';
  target.search = queryAt === -1 ? '' : logicalPath.slice(queryAt);
  if (token !== null) target.searchParams.set(PREVIEW_BOOTSTRAP_PARAM, token);
  return target.toString();
}

/**
 * The query parameter the preview listener reads its one-time token from, and
 * the path it answers reachability probes on. Both are duplicated from the
 * server (`services/workbench-serve/preview-listener.ts`) rather than shared,
 * because they are wire format between a browser and a plain HTTP listener that
 * has no other contract with the client.
 */
const PREVIEW_BOOTSTRAP_PARAM = '__dorkos_preview';

/** The listener's unauthenticated reachability endpoint, relative to its origin. */
export const PREVIEW_HEALTH_PATH = '/__dorkos_preview/health';

/** Default port for a URL that omits one, by protocol. */
function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * Classify a browser navigation target into how it should be loaded.
 *
 * A string that parses as an `http(s)` URL is `proxy` when its host is loopback,
 * else `external`. A `file:` URL or any non-URL string is a local `serve` path.
 * `javascript:`/`data:`/`blob:` URLs are `blocked`.
 *
 * @param raw - The raw URL or local path to classify.
 * @returns The classified {@link BrowserTarget}.
 */
export function classifyBrowserTarget(raw: string): BrowserTarget {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Not a URL — treat as a local file path served from the session cwd.
    return { mode: 'serve', path: raw };
  }

  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) return { mode: 'blocked' };

  if (parsed.protocol === 'file:') {
    return { mode: 'serve', path: decodeURIComponent(parsed.pathname) };
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (isLoopbackHost(parsed.hostname)) {
      const port = parsed.port ? Number(parsed.port) : defaultPort(parsed.protocol);
      // The hostname is carried so a message about this target can name it the
      // way the user typed it — telling someone who entered `127.0.0.1:5399`
      // that nothing is listening on `localhost` invites them to doubt the
      // message rather than the port.
      return {
        mode: 'proxy',
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
      };
    }
    return { mode: 'external', url: raw };
  }

  // Any other scheme (mailto:, about:, etc.) is not something we frame.
  return { mode: 'blocked' };
}

/**
 * Normalize address-bar input into a navigable target. The rules, in order:
 * - empty → empty;
 * - already a `scheme://…` URL (http/https/file) → untouched (requiring `//`
 *   avoids misreading `localhost:3000` host:port as a scheme);
 * - an explicit local path (`/…`, `./…`, `../…`) → untouched (routed to `serve`);
 * - a slash-bearing value whose first segment isn't host-like — no dot, no port
 *   (e.g. `demo/index.html`) → untouched, treated as a relative local path so it
 *   re-mints a signed serve URL against the session cwd rather than becoming a
 *   bogus `https://demo/…`;
 * - otherwise host-like (`example.com`, `localhost:3000`) → gets a scheme: `http`
 *   for a loopback host (dev servers are overwhelmingly plain http), `https`
 *   otherwise.
 *
 * Known edge: a bare single-segment filename like `preview.html` reads as a host
 * and becomes `https://preview.html` — re-navigating a lone local file by typing
 * its name is inherently ambiguous, and links (not retyping) are the common path.
 *
 * @param input - Raw address-bar text.
 * @returns A URL or path string ready for {@link classifyBrowserTarget}.
 */
export function normalizeAddressInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return trimmed;
  }
  const firstSegment = trimmed.split('/')[0];
  const looksLikeRelativePath =
    trimmed.includes('/') && !firstSegment.includes('.') && !firstSegment.includes(':');
  if (looksLikeRelativePath) return trimmed;
  const host = firstSegment.split(':')[0];
  const scheme = isLoopbackHost(host) ? 'http' : 'https';
  return `${scheme}://${trimmed}`;
}

/**
 * How the address bar should render a logical URL at rest (Chrome/Safari-style
 * simplification). The bar never displays the signed serve/proxy token URL — it
 * shows the logical target the user navigated to.
 */
export type AddressDisplay =
  | { kind: 'local'; path: string }
  | { kind: 'url'; host: string; rest: string }
  | { kind: 'raw'; text: string };

/**
 * Simplify a logical URL into display segments for the at-rest address bar:
 * - a local `serve` target → `{ kind: 'local', path }` (shown with a "local"
 *   chip; the path is the logical source, never the signed token URL);
 * - an `http(s)` / loopback target → `{ kind: 'url', host, rest }` with the
 *   scheme and a leading `www.` stripped, the host (including a non-default
 *   port, which is the identity of a dev server) emphasized, and the path/query
 *   de-emphasized;
 * - anything else (blocked/unparsable) → `{ kind: 'raw', text }`.
 *
 * @param raw - The logical URL or path currently loaded in the browser.
 * @returns The {@link AddressDisplay} segments to render.
 */
export function describeAddress(raw: string): AddressDisplay {
  const target = classifyBrowserTarget(raw);
  if (target.mode === 'serve') return { kind: 'local', path: target.path };
  if (target.mode === 'blocked') return { kind: 'raw', text: raw };
  try {
    const parsed = new URL(raw);
    const host = parsed.host.replace(/^www\./, '');
    const rest =
      parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
        ? ''
        : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return { kind: 'url', host, rest };
  } catch {
    return { kind: 'raw', text: raw };
  }
}
