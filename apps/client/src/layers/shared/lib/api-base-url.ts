/**
 * Resolve the server API base URL for the current runtime (web vs Electron).
 *
 * The standalone web client talks to a relative `/api` path (proxied by Vite in
 * dev, served directly in production). The packaged desktop shell is normally
 * served BY that server too (`http://localhost:<port>`, see
 * `window-manager.ts`), so a relative path would reach it — but the shell also
 * has a `file://` last resort, where nothing relative can, so the base URL is
 * pinned to the dynamic localhost port exposed via the preload bridge.
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
    // The relative path is the better answer wherever the page has a real
    // origin: the packaged shell is served BY the server it is asking
    // (`http://localhost:<port>`), so `/api` resolves to the same place the
    // port would have. It only fails on the shell's `file://` last resort —
    // and there it fails as requests that retry, not as a module that throws
    // on the way up. Either way the log line says the port never arrived.
    console.error(
      `[dorkos] The desktop shell reported no server port (${String(port)}); ` +
        `falling back to a relative /api path until it does.`
    );
    return '/api';
  }
  return `http://localhost:${port}/api`;
}
