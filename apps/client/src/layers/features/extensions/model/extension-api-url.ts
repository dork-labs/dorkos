import { resolveApiBaseUrl } from '@/layers/shared/lib';

/**
 * Build an absolute extensions API URL from a path.
 *
 * Every extensions-feature request (list/detail fetches, secrets/settings
 * CRUD, and dynamic bundle imports) must resolve against the server's origin,
 * not the renderer's. The standalone web client can get away with a bare
 * `/api/...` path because Vite proxies it same-origin, but the desktop shell's
 * renderer loads from the electron-vite dev server (dev) or `file://`
 * (packaged) — neither of which is the DorkOS API server. A relative fetch
 * there resolves against the renderer origin and silently returns `index.html`
 * instead of JSON (DOR-243).
 *
 * `resolveApiBaseUrl()` is the same seam {@link HttpTransport} and the auth
 * client use to reach the server, so this keeps the extensions feature on the
 * established pattern rather than inventing a second one.
 *
 * @param path - Path under `/extensions`, e.g. `/extensions/${id}/bundle` (leading slash required)
 * @returns The fully-qualified URL to fetch or import
 */
export function extensionApiUrl(path: string): string {
  return `${resolveApiBaseUrl()}${path}`;
}
