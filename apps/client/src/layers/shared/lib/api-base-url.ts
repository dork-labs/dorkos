/**
 * Resolve the server API base URL for the current runtime (web vs Electron).
 *
 * The standalone web client talks to a relative `/api` path (proxied by Vite in
 * dev, served directly in production). In packaged Electron the renderer may load
 * from `file://`, where a relative path cannot reach the localhost server, so the
 * base URL is pinned to the dynamic localhost port exposed via the preload bridge.
 *
 * Shared by the {@link HttpTransport} construction in `main.tsx` and the auth
 * client (`features/auth`), so both speak to the same origin — Better Auth session
 * cookies only ride requests that hit the same host the cookie was set on.
 *
 * @module shared/lib/api-base-url
 */

/** Resolve the `/api` base URL, honoring the Electron preload server port when present. */
export function resolveApiBaseUrl(): string {
  if (window.electronAPI?.getServerPort) {
    const port = window.electronAPI.getServerPort();
    return `http://localhost:${port}/api`;
  }
  return '/api';
}
