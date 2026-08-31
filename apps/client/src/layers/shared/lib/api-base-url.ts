/**
 * Resolve the server API base URL for the current runtime (web vs Electron).
 *
 * The standalone web client talks to a relative `/api` path (proxied by Vite in
 * dev, served directly in production). The packaged desktop shell is served BY
 * that same server (`http://localhost:<port>`, see `window-manager.ts`) — it
 * does NOT load from `file://`; that changed with ADR 260712-005315, which
 * moved the packaged window to `loadURL('http://localhost:<port>')`
 * specifically to make relative API paths and cookie-based auth work at all
 * (a `file://` page sends `Origin: null`, which the server's CORS allowlist
 * rejects). So a relative path would resolve correctly today — this module
 * pins the base URL to the dynamic port from the preload bridge instead
 * because the port can still be legitimately unknown for a moment (startup,
 * after a crash, between restarts), and an absolute URL is what makes that
 * window explicit rather than silently mis-resolving.
 *
 * Shared by the {@link HttpTransport} construction in `main.tsx` and the auth
 * client (`features/auth`), so both speak to the same origin — Better Auth session
 * cookies only ride requests that hit the same host the cookie was set on.
 *
 * @module shared/lib/api-base-url
 */

/** The highest port a TCP server can be listening on. */
const MAX_PORT = 65_535;

/**
 * Whether the shell handed back a port something could actually be serving on.
 *
 * The bridge answers `null` whenever the server is not up — during startup,
 * after a crash, between restarts — and this module runs at boot, so that is a
 * normal answer rather than an exotic one. Interpolating it produced
 * `http://localhost:null/api`, an origin every later request and every durable
 * stream then failed against with no explanation.
 *
 * @param port - Whatever `getServerPort()` returned.
 */
function isServingPort(port: number | null): port is number {
  return port !== null && Number.isInteger(port) && port > 0 && port <= MAX_PORT;
}

/** Resolve the `/api` base URL, honoring the Electron preload server port when present. */
export function resolveApiBaseUrl(): string {
  if (!window.electronAPI?.getServerPort) return '/api';
  const port = window.electronAPI.getServerPort();
  if (!isServingPort(port)) {
    // The relative path is the correct answer here: the packaged shell is
    // served BY the server it is asking (`http://localhost:<port>`, ADR
    // 260712-005315 — it never loads from `file://`), so `/api` resolves to
    // the same place the port would have. This branch exists for the
    // genuinely transient case where the bridge hasn't reported a port yet
    // (startup, after a crash, between restarts); the log line says so.
    console.error(
      `[dorkos] The desktop shell reported no server port (${String(port)}); ` +
        `falling back to a relative /api path until it does.`
    );
    return '/api';
  }
  return `http://localhost:${port}/api`;
}
