import type { UiCanvasContent } from '@dorkos/shared/types';
import type { CanvasDocument as ServerCanvasDocument } from '@dorkos/shared/room-schemas';
import type { CanvasDocument } from './app-store-canvas';

/** Base name of a filesystem-ish path, for a tab label. */
function baseName(pathLike: string): string {
  const parts = pathLike.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? pathLike;
}

const CONTENT_TYPE_FALLBACK_LABELS: Record<UiCanvasContent['type'], string> = {
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

/** Human label for a document tab — the content title, else a source-derived name. */
export function sourceLabel(content: UiCanvasContent): string {
  if (content.title) return content.title;
  switch (content.type) {
    case 'markdown':
      return content.sourcePath
        ? baseName(content.sourcePath)
        : CONTENT_TYPE_FALLBACK_LABELS.markdown;
    case 'file':
      return baseName(content.sourcePath);
    case 'diff':
      return baseName(content.sourcePath);
    case 'image':
    case 'pdf':
    case 'model3d':
    case 'audio':
    case 'video':
    case 'csv':
      return /^(https?:|data:)/.test(content.src)
        ? CONTENT_TYPE_FALLBACK_LABELS[content.type]
        : baseName(content.src);
    case 'url':
      try {
        return new URL(content.url).hostname;
      } catch {
        return CONTENT_TYPE_FALLBACK_LABELS.url;
      }
    case 'browser':
      try {
        return new URL(content.url).hostname;
      } catch {
        // A bare local file path (not a URL) → use its base name for the tab.
        return baseName(content.url);
      }
    default:
      return CONTENT_TYPE_FALLBACK_LABELS[content.type];
  }
}

/**
 * Fold one of the server's rows into the shape this slice holds, keeping the
 * per-viewer fields of the row it replaces.
 *
 * `editing` and `heldUpdate` are this window's own and never the server's, so
 * they survive every arrival — a document somebody is typing in must not lose
 * their draft because a frame landed.
 */
export function fromServer(row: ServerCanvasDocument, previous?: CanvasDocument): CanvasDocument {
  return {
    id: row.id,
    rev: row.rev,
    content: row.content,
    openedAt: Date.parse(row.openedAt),
    lastActiveAt: Date.parse(row.lastActiveAt),
    sourceLabel: row.title || sourceLabel(row.content),
    pinned: row.pinned,
    // Kept across arrivals, like `editing` below: the server's row says nothing
    // about which window a person opened it in, so the answer this window
    // already had is the only one there is. Absent means it arrived from the
    // server — a hydrate, or another window's open.
    openedHere: previous?.openedHere ?? false,
    editing: previous?.editing ?? false,
    heldUpdate: previous?.heldUpdate ?? null,
  };
}
