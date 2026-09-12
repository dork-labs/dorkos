/**
 * What makes two canvas opens the same document, and what a document is called
 * (spec `room-canvas` §3.2, §5.7).
 *
 * **Pure, and deliberately the only thing in this folder that is.** Every
 * function here is a value in, a value out: no store, no clock, no randomness
 * except where it is the whole point ({@link canvasDocumentId} for content with
 * no identity).
 *
 * The dedupe key itself is NOT declared here. It lives in
 * `@dorkos/shared/canvas-source-key` and is re-exported, because the client's
 * own store dedupes with the same rule — two implementations of "is this the
 * same document" would drift silently into a table with two tabs for one file,
 * and one function cannot.
 *
 * @module server/services/canvas/document-key
 */
import { createHash, randomUUID } from 'node:crypto';
import { canvasSourceKey } from '@dorkos/shared/canvas-source-key';
import type { UiCanvasContent } from '@dorkos/shared/schemas';

export { canvasSourceKey };

/**
 * The id a document gets: deterministic from its scope and source key, or random
 * when it has no key.
 *
 * **Deterministic is what makes the table a table.** Two agents opening
 * `src/router.ts` in one room — or two windows of one session opening it —
 * compute the same id, so the second open finds the first's row and refreshes it
 * instead of adding a second tab beside it. It is a hash rather than the key
 * itself so the id is opaque and a fixed length — a document id travels into
 * tool results and prompts, and a raw absolute path there would leak a directory
 * layout into a room.
 *
 * **Random is what makes `json` and `widget` behave.** They have no key, so every
 * open is a fresh document, which is how the client's store has always treated
 * them.
 *
 * @param scope - The table this document belongs to — `room:<id>` or `session:<id>`.
 * @param sourceKey - The dedupe key, or `null` for content with no identity.
 * @returns The document id.
 */
export function canvasDocumentId(scope: string, sourceKey: string | null): string {
  if (sourceKey === null) return randomUUID();
  return createHash('sha256').update(`${scope}\u0000${sourceKey}`).digest('hex').slice(0, 32);
}

/** Base name of a filesystem-ish path, for a document label. */
function baseName(pathLike: string): string {
  const parts = pathLike.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? pathLike;
}

/** What a document with no title of its own is called, per content type. */
const FALLBACK_LABELS: Record<UiCanvasContent['type'], string> = {
  url: 'Web Page',
  markdown: 'Document',
  json: 'JSON Data',
  image: 'Image',
  pdf: 'PDF',
  widget: 'Widget',
  mcp_app: 'App',
  file: 'File',
  model3d: '3D Model',
  audio: 'Audio',
  video: 'Video',
  csv: 'CSV',
  browser: 'Browser',
  diff: 'Diff',
};

/**
 * What this document is called — its own title, else something derived from
 * where it came from.
 *
 * Cached on the row so listing a room's canvas does not have to parse every
 * content blob, and mirrors the client's `sourceLabel` for the same reason
 * {@link canvasSourceKey} mirrors its `sourceKey`: two answers to "what is this
 * tab called" is one answer too many.
 *
 * @param content - The canvas content.
 * @returns A short label a person can read.
 */
export function canvasTitle(content: UiCanvasContent): string {
  if (content.title) return content.title;
  switch (content.type) {
    case 'markdown':
      return content.sourcePath ? baseName(content.sourcePath) : FALLBACK_LABELS.markdown;
    case 'file':
    case 'diff':
      return baseName(content.sourcePath);
    case 'image':
    case 'pdf':
    case 'model3d':
    case 'audio':
    case 'video':
    case 'csv':
      return /^(https?:|data:)/.test(content.src)
        ? FALLBACK_LABELS[content.type]
        : baseName(content.src);
    case 'url':
      try {
        return new URL(content.url).hostname;
      } catch {
        return FALLBACK_LABELS.url;
      }
    case 'browser':
      try {
        return new URL(content.url).hostname;
      } catch {
        // A bare local file path rather than a URL — its base name is the label.
        return baseName(content.url);
      }
    default:
      return FALLBACK_LABELS[content.type];
  }
}

/**
 * The file path a document resolves against, or `null` when it names no file.
 *
 * Read once at open time so the row can record WHICH directory the path was
 * resolved under, and read again at every later read so the §8.1 rule — a canvas
 * document never lets a member read a tree they could not already read — is
 * evaluated on the READER rather than assumed from the writer.
 *
 * @param content - The canvas content.
 * @returns The `sourcePath`, or `null` for content that names no file.
 */
export function canvasSourcePath(content: UiCanvasContent): string | null {
  switch (content.type) {
    case 'markdown':
      return content.sourcePath ?? null;
    case 'file':
    case 'diff':
      return content.sourcePath;
    default:
      return null;
  }
}
