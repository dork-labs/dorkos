/**
 * URL classification + sandbox posture for the embedded browser canvas
 * (DOR-216, ADR 260708-185519).
 *
 * The browser renders three kinds of target, each routed differently:
 * - `external` — an arbitrary `http(s)` site, framed directly (and falling back
 *   to the system browser when the site refuses embedding).
 * - `proxy` — a `localhost`/loopback dev server, routed through the signed
 *   localhost reverse-proxy so it can be framed.
 * - `serve` — a local file within the session cwd, routed through the signed
 *   static-serve route so relative assets resolve.
 *
 * Served and proxied content renders in an opaque-origin sandbox (WITHOUT
 * `allow-same-origin`) so untrusted local HTML can never call `/api/*` as the
 * user. External sites keep `allow-same-origin` — they live on their own origin,
 * so it grants them nothing against the DorkOS origin.
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

/** Hostnames treated as loopback (routed through the localhost proxy). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/** A classified browser target. */
export type BrowserTarget =
  | { mode: 'external'; url: string }
  | { mode: 'proxy'; port: number; path: string }
  | { mode: 'serve'; path: string }
  | { mode: 'blocked' };

/** Whether a URL's hostname is a loopback address. */
function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

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
      return { mode: 'proxy', port, path: `${parsed.pathname}${parsed.search}` };
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
