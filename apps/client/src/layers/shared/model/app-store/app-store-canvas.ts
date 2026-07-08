/**
 * Canvas slice — per-session multi-document canvas state for the app store.
 *
 * The canvas hosts several open documents at once (files, images, pages, agent
 * output) via `openDocuments` + `activeDocumentId`; agent `open_*` commands
 * append-and-activate (deduping by source), while `update_canvas` mutates the
 * active document. Edit-protection is per-document: while one document is being
 * edited, agent pushes to it are held (ADR-0292), but other documents stay
 * agent-writable. The document array is persisted per-session via localStorage
 * (see the canvas session helpers in app-store-helpers.ts). See ADR
 * 260708-185518 (multi-document canvas model).
 *
 * @module shared/model/app-store-canvas
 */
import type { StateCreator } from 'zustand';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { MAX_CANVAS_DOCUMENTS } from '@/layers/shared/lib';
import { readCanvasSession, writeCanvasSession } from './app-store-helpers';
import type { PersistedCanvasDocument } from './app-store-helpers';
import type { AppState } from './app-store-types';

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

/** A single open canvas document. */
export interface CanvasDocument {
  /** Stable client-generated id (tab key + activation target). */
  id: string;
  /** The rendered content for this document. */
  content: UiCanvasContent;
  /** Epoch ms the document was first opened (tab order). */
  openedAt: number;
  /** Epoch ms the document was last activated (LRU eviction recency). */
  lastActiveAt: number;
  /** Short label for the document tab. */
  sourceLabel: string;
  /**
   * Per-document edit-protection. While `true`, agent content pushes to THIS
   * document are held so the in-canvas editor is the sole writer (ADR-0292).
   * Transient — never persisted, so a reload never resurrects edit mode.
   */
  editing: boolean;
}

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface CanvasSlice {
  canvasOpen: boolean;
  setCanvasOpen: (open: boolean) => void;

  /** All open documents, in open order (tab order). */
  openDocuments: CanvasDocument[];
  /** Id of the active document, or null when none are open. */
  activeDocumentId: string | null;

  /**
   * Append a document for `content` and activate it. Dedups by source key
   * (`sourcePath`/`src`/`url`/`uri`): re-activates and refreshes an existing
   * document rather than opening a duplicate — but preserves the existing
   * document's content while it is being edited (edit-protection). Evicts the
   * least-recently-active document when over {@link MAX_CANVAS_DOCUMENTS}.
   */
  openCanvasDocument: (content: UiCanvasContent) => void;
  /**
   * Mutate the active document's content (the agent `update_canvas` path). A
   * no-op while the active document is being edited, or when none is active.
   */
  updateActiveDocument: (content: UiCanvasContent) => void;
  /**
   * Write the active document's content unconditionally (the in-canvas editor's
   * own write + conflict-reload path). Unlike {@link updateActiveDocument} this
   * ignores edit-protection because the editor IS the protected writer.
   */
  setActiveDocumentContent: (content: UiCanvasContent) => void;
  /** Close a document by id, activating the most-recently-active remaining one. */
  closeCanvasDocument: (id: string) => void;
  /** Activate an already-open document by id. */
  activateCanvasDocument: (id: string) => void;
  /**
   * Set a specific document's edit-protection flag by id. Id-scoped (not
   * active-scoped) so an editor can clear its OWN document's flag on unmount —
   * e.g. after a tab switch has already changed the active document — instead of
   * leaving it stuck `true` and permanently dropping agent updates to it.
   */
  setDocumentEditing: (id: string, editing: boolean) => void;

  canvasPreferredWidth: number | null;
  setCanvasPreferredWidth: (width: number | null) => void;
  /** Active session ID for canvas persistence; null until `loadCanvasForSession` is called. */
  canvasSessionId: string | null;
  /** Load canvas state for a session (or reset to defaults if no prior state exists). */
  loadCanvasForSession: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Dedup key for a content variant, or null when the variant has no stable identity. */
function sourceKey(content: UiCanvasContent): string | null {
  switch (content.type) {
    case 'url':
      return `url:${content.url}`;
    case 'markdown':
      return content.sourcePath ? `path:${content.sourcePath}` : null;
    case 'file':
      return `path:${content.sourcePath}`;
    case 'image':
    case 'pdf':
    case 'model3d':
    case 'csv':
      return `src:${content.src}`;
    case 'mcp_app':
      return `mcp:${content.serverName}:${content.uri}`;
    case 'json':
    case 'widget':
      // No natural identity — every open is a fresh document.
      return null;
  }
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
  csv: 'CSV',
};

/** Human label for a document tab — the content title, else a source-derived name. */
function sourceLabel(content: UiCanvasContent): string {
  if (content.title) return content.title;
  switch (content.type) {
    case 'markdown':
      return content.sourcePath
        ? baseName(content.sourcePath)
        : CONTENT_TYPE_FALLBACK_LABELS.markdown;
    case 'file':
      return baseName(content.sourcePath);
    case 'image':
    case 'pdf':
    case 'model3d':
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
    default:
      return CONTENT_TYPE_FALLBACK_LABELS[content.type];
  }
}

/** Generate a stable document id. */
function makeDocumentId(): string {
  return crypto.randomUUID();
}

/**
 * Enforce the open-document cap by dropping the least-recently-active documents,
 * never evicting the just-activated one or a document being edited.
 */
function evictToCapacity(documents: CanvasDocument[], protectedId: string): CanvasDocument[] {
  if (documents.length <= MAX_CANVAS_DOCUMENTS) return documents;
  const evictable = documents
    .filter((d) => d.id !== protectedId && !d.editing)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  const dropCount = documents.length - MAX_CANVAS_DOCUMENTS;
  const dropIds = new Set(evictable.slice(0, dropCount).map((d) => d.id));
  return documents.filter((d) => !dropIds.has(d.id));
}

/** The durable projection of the in-memory documents (drops the transient `editing` flag). */
function toPersisted(documents: CanvasDocument[]): PersistedCanvasDocument[] {
  return documents.map(({ id, content, openedAt, lastActiveAt, sourceLabel: label }) => ({
    id,
    content,
    openedAt,
    lastActiveAt,
    sourceLabel: label,
  }));
}

/** Persist the given canvas state for the active session (no-op without a session). */
function persist(
  sessionId: string | null,
  state: { canvasOpen: boolean; openDocuments: CanvasDocument[]; activeDocumentId: string | null }
): void {
  if (!sessionId) return;
  writeCanvasSession(sessionId, {
    open: state.canvasOpen,
    documents: toPersisted(state.openDocuments),
    activeDocumentId: state.activeDocumentId,
    accessedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Slice creator
// ---------------------------------------------------------------------------

/** Creates the canvas slice (persisted per-session multi-document canvas state). */
export const createCanvasSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  CanvasSlice
> = (set, get) => ({
  canvasOpen: false,
  setCanvasOpen: (open) =>
    set((s) => {
      persist(s.canvasSessionId, { ...s, canvasOpen: open });
      return { canvasOpen: open };
    }),

  openDocuments: [],
  activeDocumentId: null,

  openCanvasDocument: (content) =>
    set((s) => {
      const key = sourceKey(content);
      const existingIdx = key ? s.openDocuments.findIndex((d) => sourceKey(d.content) === key) : -1;
      const now = Date.now();

      let documents: CanvasDocument[];
      let activeId: string;

      if (existingIdx >= 0) {
        const existing = s.openDocuments[existingIdx];
        activeId = existing.id;
        // Re-activate; refresh content + label unless the doc is being edited.
        const refreshed: CanvasDocument = existing.editing
          ? { ...existing, lastActiveAt: now }
          : { ...existing, content, sourceLabel: sourceLabel(content), lastActiveAt: now };
        documents = s.openDocuments.map((d, i) => (i === existingIdx ? refreshed : d));
      } else {
        const doc: CanvasDocument = {
          id: makeDocumentId(),
          content,
          openedAt: now,
          lastActiveAt: now,
          sourceLabel: sourceLabel(content),
          editing: false,
        };
        activeId = doc.id;
        documents = evictToCapacity([...s.openDocuments, doc], activeId);
      }

      const next = { openDocuments: documents, activeDocumentId: activeId };
      persist(s.canvasSessionId, { ...s, ...next });
      return next;
    }),

  updateActiveDocument: (content) => {
    const s = get();
    const active = s.openDocuments.find((d) => d.id === s.activeDocumentId);
    // Protect the edit (ADR-0292): ignore agent pushes while this doc is edited.
    if (!active || active.editing) return;
    s.setActiveDocumentContent(content);
  },

  setActiveDocumentContent: (content) =>
    set((s) => {
      if (!s.activeDocumentId) return {};
      const documents = s.openDocuments.map((d) =>
        d.id === s.activeDocumentId ? { ...d, content, sourceLabel: sourceLabel(content) } : d
      );
      persist(s.canvasSessionId, { ...s, openDocuments: documents });
      return { openDocuments: documents };
    }),

  closeCanvasDocument: (id) =>
    set((s) => {
      const documents = s.openDocuments.filter((d) => d.id !== id);
      let activeId = s.activeDocumentId;
      if (activeId === id) {
        // Activate the most-recently-active remaining document.
        const next = [...documents].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        activeId = next?.id ?? null;
      }
      const nextState = { openDocuments: documents, activeDocumentId: activeId };
      persist(s.canvasSessionId, { ...s, ...nextState });
      return nextState;
    }),

  activateCanvasDocument: (id) =>
    set((s) => {
      if (!s.openDocuments.some((d) => d.id === id)) return {};
      const documents = s.openDocuments.map((d) =>
        d.id === id ? { ...d, lastActiveAt: Date.now() } : d
      );
      const nextState = { openDocuments: documents, activeDocumentId: id };
      persist(s.canvasSessionId, { ...s, ...nextState });
      return nextState;
    }),

  setDocumentEditing: (id, editing) =>
    set((s) => {
      if (!s.openDocuments.some((d) => d.id === id)) return {};
      const documents = s.openDocuments.map((d) => (d.id === id ? { ...d, editing } : d));
      // `editing` is transient — not persisted.
      return { openDocuments: documents };
    }),

  canvasPreferredWidth: null,
  setCanvasPreferredWidth: (width) => set({ canvasPreferredWidth: width }),

  canvasSessionId: null,
  loadCanvasForSession: (sessionId) => {
    const entry = readCanvasSession(sessionId);
    // Hydrate documents fresh (transient `editing` always starts false) so a new
    // session never inherits the previous one's edit mode.
    if (entry) {
      set({
        canvasOpen: entry.open,
        // Hydrate fresh: `editing` always starts false, and any doc with an
        // empty label (e.g. a legacy pre-DOR-219 doc migrated on read) gets one
        // derived from its content so its tab never renders blank.
        openDocuments: entry.documents.map((d) => ({
          ...d,
          editing: false,
          sourceLabel: d.sourceLabel || sourceLabel(d.content),
        })),
        activeDocumentId: entry.activeDocumentId,
        canvasSessionId: sessionId,
      });
    } else {
      set({
        canvasOpen: false,
        openDocuments: [],
        activeDocumentId: null,
        canvasSessionId: sessionId,
      });
    }
  },
});
