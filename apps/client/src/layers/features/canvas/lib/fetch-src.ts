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
 * @param allowedDataPrefix - Restrict `data:` URIs to this prefix, the way
 *   `media-src.ts` restricts them per media kind. Pass it wherever the resolved
 *   URL can end up in an `<a href>`: a `data:text/html` source is a legitimate
 *   thing for a `<video src>` to fail to play, and not a thing to offer as a
 *   link (DOR-924). Omitted by the viewers that only ever fetch the bytes.
 *
 *   **The gate sits on the resolver, so it is the whole viewer it refuses, not
 *   just the link.** A `data:text/html` video source now yields `url: null` and
 *   the "This video can't be played here" state — the `<video>` element never
 *   gets a `src` either. That is deliberate and it is `media-src.ts`'s
 *   precedent, not a new rule: a media viewer pointed at a source whose type
 *   does not match the viewer had nothing to show in the first place, and one
 *   refusal a reader can see beats an element that silently fails to load
 *   beside a link that quietly still works.
 */
export function resolveCanvasFetchUrl(
  src: string,
  toLocalUrl: (filePath: string) => string | null,
  allowedDataPrefix?: string
): ResolvedCanvasFetch {
  const trimmed = src.trim();
  const scheme = schemeOf(trimmed);
  if (scheme !== null) {
    if (!REMOTE_SCHEMES.has(scheme)) return { url: null };
    if (scheme === 'data:' && allowedDataPrefix !== undefined) {
      return trimmed.toLowerCase().startsWith(allowedDataPrefix) ? { url: trimmed } : { url: null };
    }
    return { url: trimmed };
  }
  return { url: toLocalUrl(trimmed) };
}
