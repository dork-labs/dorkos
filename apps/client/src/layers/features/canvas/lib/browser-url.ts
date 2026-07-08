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
 * Normalize address-bar input into a navigable target. Bare host-like input
 * (`example.com`, `localhost:3000`) gets an `https://`/`http://` scheme so it
 * classifies as a URL rather than a local path; existing schemes and local
 * paths pass through untouched.
 *
 * @param input - Raw address-bar text.
 * @returns A URL or path string ready for {@link classifyBrowserTarget}.
 */
export function normalizeAddressInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return trimmed;
  // Already a `scheme://…` URL (http/https/file) — leave it alone. Requiring the
  // `//` avoids misreading `localhost:3000` (host:port) as a scheme.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return trimmed;
  }
  // Host-like (has a dot or a port) → default to http for a loopback host,
  // https otherwise. Loopback dev servers are overwhelmingly plain http.
  const host = trimmed.split('/')[0].split(':')[0];
  const scheme = isLoopbackHost(host) ? 'http' : 'https';
  return `${scheme}://${trimmed}`;
}
