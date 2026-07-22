/**
 * Resolve a canvas `src` into a same-origin (or remote) URL the browser can load.
 *
 * Used by the viewers that don't gate `data:` URIs by media kind: the CSV viewer
 * (which fetches the bytes and parses them as text) and the 3D/audio/video viewers
 * (which point a `<model-viewer>`/`<audio>`/`<video>` element at the URL, streaming
 * the bytes rather than parsing them as text).
 *
 * Remote (`http(s):`) and `data:` sources are returned directly; a local filesystem
 * path is routed through the server's cwd-confined raw-file URL (which serves Range
 * requests, so media can seek). Any other explicit scheme (`javascript:`, `file:`,
 * `blob:`, …) is rejected. Mirrors the classification in `media-src.ts` but without
 * its image/pdf `data:`-prefix gate.
 *
 * @module features/canvas/lib/fetch-src
 */

/** Outcome of resolving a fetchable source: a URL to fetch, or null when unavailable. */
export interface ResolvedCanvasFetch {
  /** URL to fetch, or null when the source can't be resolved here. */
  url: string | null;
}

/** Leading `scheme:` of a source, or null when it has none (a bare filesystem path). */
function schemeOf(src: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(src);
  if (!match) return null;
  // A single-letter "scheme" is a Windows drive prefix (e.g. C:\…), not a URL.
  if (match[1].length === 1) return null;
  return `${match[1].toLowerCase()}:`;
}

const REMOTE_SCHEMES = new Set(['http:', 'https:', 'data:']);

/**
 * Resolve a fetchable canvas source to a URL.
 *
 * @param src - The source (https/http/data URL, or a local path).
 * @param toLocalUrl - Builds a same-origin URL for a local path (from the
 *   transport), or null when local files can't be served here.
 */
export function resolveCanvasFetchUrl(
  src: string,
  toLocalUrl: (filePath: string) => string | null
): ResolvedCanvasFetch {
  const trimmed = src.trim();
  const scheme = schemeOf(trimmed);
  if (scheme !== null) {
    return REMOTE_SCHEMES.has(scheme) ? { url: trimmed } : { url: null };
  }
  return { url: toLocalUrl(trimmed) };
}
