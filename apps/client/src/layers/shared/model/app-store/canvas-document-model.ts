import type { UiCanvasContent } from '@dorkos/shared/types';
import type { CanvasDocument as ServerCanvasDocument } from '@dorkos/shared/room-schemas';

/** A single open canvas document. */
export interface CanvasDocument {
  /**
   * The SERVER's document id — the tab key, the activation target, and the id
   * `read_canvas_document` takes.
   *
   * A document this window has just opened and not yet heard back about holds a
   * `pending:` id instead, for exactly as long as the POST is in flight.
   */
  id: string;
  /** Server rows present before this unresolved local open; never defer these as its echo. */
  pendingBaselineIds?: string[];
  /** Possible stream echoes observed while this open is unresolved; cleared with its pending row. */
  pendingCandidateIds?: string[];
  /**
   * The row's revision, monotonic per session. What orders two frames racing
   * for one document: a lower `rev` never overwrites a higher one. `0` on a row
   * this window minted optimistically and the server has not answered for.
   */
  rev: number;
  /** The rendered content for this document. */
  content: UiCanvasContent;
  /** Epoch ms the document was first opened (tab order). */
  openedAt: number;
  /** Epoch ms the document was last activated (LRU eviction recency). */
  lastActiveAt: number;
  /** Short label for the document tab. */
  sourceLabel: string;
  /**
   * The app whose screen opened this, from the server's record (DOR-3293).
   * Host-written metadata, never read from content; the tab names the app.
   */
  openedBy?: { extensionId: string };
  /**
   * Whether somebody pinned this document.
   *
   * Carried from the server's row because the CAP is over unpinned documents
   * only, on both sides. Without it this window counted pinned rows toward the
   * twelve and evicted locally what the server keeps — which the next hydrate
   * simply put back (DOR-2006 review, finding 10a).
   */
  pinned: boolean;
  /**
   * Whether a person in THIS window put this document here.
   *
   * **Per-viewer and transient, like {@link CanvasDocument.editing}** — never the
   * server's, and it survives an arriving frame for the same reason that one
   * does. The table is shared now, so a document can appear in a window because
   * somebody did something HERE, or because somebody did something in another
   * window and the row synced over. Only the first is a person bringing a page
   * to the front, and the driver seat turns on that difference: a window that
   * merely received a row must not take the seat from the window the person is
   * actually using (`use-devtools-bridge.ts`).
   */
  openedHere: boolean;
  /**
   * Per-document edit-protection. While `true`, agent content pushes to THIS
   * document are held so the in-canvas editor is the sole writer (ADR-0292).
   * Transient — never persisted, so a reload never resurrects edit mode.
   */
  editing: boolean;
  /**
   * The agent push that arrived while this document was being edited, kept
   * rather than dropped — ADR-0292's deferred notify-and-reconcile half.
   *
   * `null` when nothing is waiting. Only the NEWEST held push is kept: a person
   * choosing between their draft and "the agent's version" means the current
   * one, and a queue of superseded versions is a queue nobody would read.
   *
   * The invariant that makes that true is **a push that lands clears any hold**,
   * on every write path — otherwise a hold taken during an edit outlives the
   * edit, a later push lands while nobody is editing, and Reload then replaces
   * what is on screen with a version OLDER than it. A hold does survive the edit
   * ending, though, and deliberately: a choice the person has not answered is
   * not a choice to delete the moment they stop typing, which is the silent drop
   * this whole field exists to remove.
   *
   * Transient, like {@link editing} — a reload starts with nothing held.
   */
  heldUpdate: UiCanvasContent | null;
}

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
    // Only from the server's record, never from content; a row without it has none.
    ...(row.openedBy && { openedBy: row.openedBy }),
    // Kept across arrivals, like `editing` below: the server's row says nothing
    // about which window a person opened it in, so the answer this window
    // already had is the only one there is. Absent means it arrived from the
    // server — a hydrate, or another window's open.
    openedHere: previous?.openedHere ?? false,
    editing: previous?.editing ?? false,
    heldUpdate: previous?.heldUpdate ?? null,
  };
}
