/**
 * Resolve a canvas media `src` (image/pdf) into a loadable URL.
 *
 * The agent may point a media canvas at three kinds of source: a remote
 * `https://`/`http://` URL, a `data:` URI, or a local file path. Remote and data
 * sources load directly; local paths must go through the server's cwd-confined
 * raw-file route. This module owns that classification so the renderers stay thin
 * and the rules are unit-tested in one place.
 *
 * @module features/canvas/lib/media-src
 */

/** The media variant a source is being resolved for — gates which `data:` URIs are allowed. */
export type CanvasMediaKind = 'image' | 'pdf';

/** Why a media source can't be shown, when {@link ResolvedCanvasMedia.url} is null. */
export type CanvasMediaError = 'blocked' | 'local-unavailable' | 'unsupported-data';

/** Outcome of resolving a media source: a URL to load, or a reason it's unavailable. */
export interface ResolvedCanvasMedia {
  /** URL to load into `<img>`/`<object>`, or null when the source can't be shown. */
  url: string | null;
  /** Set when `url` is null — why the source was rejected. */
  error: CanvasMediaError | null;
}

/** URL schemes allowed to load directly (remote fetch). */
const REMOTE_SCHEMES = new Set(['http:', 'https:']);

/** Leading `scheme:` of a source, or null when it has none (a bare filesystem path). */
function schemeOf(src: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(src);
  if (!match) return null;
  // A single-letter "scheme" is a Windows drive prefix (e.g. C:\…), not a URL.
  if (match[1].length === 1) return null;
  return `${match[1].toLowerCase()}:`;
}

/** `data:` prefix a media kind accepts, guarding against e.g. `data:text/html` in a PDF frame. */
const ALLOWED_DATA_PREFIX: Record<CanvasMediaKind, string> = {
  image: 'data:image/',
  pdf: 'data:application/pdf',
};

/**
 * Resolve a media source to a loadable URL.
 *
 * @param src - The agent-supplied source (https/http URL, data: URI, or local path).
 * @param kind - Which media variant is resolving, so `data:` URIs are type-checked.
 * @param toLocalUrl - Builds a same-origin URL for a local file path (from the
 *   transport), or returns null when local files can't be served here.
 */
export function resolveCanvasMediaSrc(
  src: string,
  kind: CanvasMediaKind,
  toLocalUrl: (filePath: string) => string | null
): ResolvedCanvasMedia {
  const trimmed = src.trim();

  if (trimmed.startsWith('data:')) {
    const ok = trimmed.toLowerCase().startsWith(ALLOWED_DATA_PREFIX[kind]);
    return ok ? { url: trimmed, error: null } : { url: null, error: 'unsupported-data' };
  }

  const scheme = schemeOf(trimmed);
  if (scheme !== null) {
    if (REMOTE_SCHEMES.has(scheme)) return { url: trimmed, error: null };
    // Any other explicit scheme (javascript:, file:, blob:, vbscript:, …) is blocked.
    return { url: null, error: 'blocked' };
  }

  // No scheme ⇒ a local filesystem path; serve it through the confined route.
  const local = toLocalUrl(trimmed);
  return local ? { url: local, error: null } : { url: null, error: 'local-unavailable' };
}

/** Human-readable message for a resolution error, shown in the canvas error state. */
export function canvasMediaErrorMessage(error: CanvasMediaError, kind: CanvasMediaKind): string {
  switch (error) {
    case 'blocked':
      return `This ${kind} source can't be displayed for security reasons.`;
    case 'unsupported-data':
      return `This data URI isn't a valid ${kind} source.`;
    case 'local-unavailable':
      return `Local ${kind} files can't be displayed here.`;
  }
}
