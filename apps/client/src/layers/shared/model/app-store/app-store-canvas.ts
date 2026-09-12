/**
 * Canvas slice — per-session multi-document canvas state for the app store.
 *
 * ONE document list, TWO views (ADR 260911-200304). `openDocuments` holds every
 * open document; the right panel shows them through two tabs, and
 * {@link canvasViewForContent} says which tab a document belongs to — the
 * Browser tab renders exactly what the embedded browser renders (`url` and
 * `browser`), the Canvas tab renders the other twelve types. Each view keeps its
 * own active document id, so switching tabs returns you to the document you left
 * there.
 *
 * Agent `open_*` commands append-and-activate in the document's own view
 * (deduping by source), while `update_canvas` mutates the active document of the
 * view its content belongs to. Edit-protection is per-document: while one
 * document is being edited, agent pushes to it are held on `heldUpdate`
 * (ADR-0292) for the canvas to offer back as Reload / Keep mine, but other
 * documents stay agent-writable. A held push is kept, never dropped — dropping
 * it in silence, with neither side told, is the half of ADR-0292 that was
 * deferred when it was written. See ADR 260708-185518 (multi-document canvas
 * model).
 *
 * ## The canvas is the SERVER's (spec `canvas-agent-seat` §1.5)
 *
 * This slice used to be the truth, persisted per session into `localStorage`. So
 * two tabs on one session held two different tables, a phone saw none of it,
 * clearing browser data lost it, and no agent could read it. Now:
 *
 * - It is **filled from `snapshot.canvas`** on the session stream's cold connect
 *   and kept current by the `canvas` event, exactly as the room slice is.
 * - Every mutator **writes through the transport** — an optimistic local apply,
 *   then the request, then the `canvas` event that comes back. A failed write
 *   reverts the optimistic apply and says so; it never leaves the two
 *   disagreeing, which is today's whole problem in a new place.
 * - A document's `id` is the SERVER's. A local open holds a `pending:` id only
 *   until the POST answers, and the answer replaces it.
 * - **`rev` is the tiebreak.** An event whose `rev` is not greater than the row
 *   this slice already holds is dropped, which makes the echo of your own write
 *   harmless and makes a second device's write win in order.
 *
 * What is NOT the server's stays here and is never sent: which document each of
 * the two views is showing, the transient `editing` flag, the held push, and
 * `browserHistories` — a back/forward stack is what THIS window did.
 *
 * @module shared/model/app-store-canvas
 */
import type { StateCreator } from 'zustand';
import { toast } from 'sonner';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type {
  CanvasDocument as ServerCanvasDocument,
  UpdateCanvasDocumentRequest,
} from '@dorkos/shared/room-schemas';
import type { Transport } from '@dorkos/shared/transport';
// The dedupe rule, shared with the server's room canvas rather than copied
// beside it (spec `room-canvas` §3.2). Two implementations of "is this the same
// document" drift silently into one room holding two tabs for one file.
//
// It keeps the property this file's two views depend on: every prefix it can
// return belongs to exactly one view (`url:`/`browser:` to Browser, the rest to
// Canvas), so a dedupe hit can never move a document from one tab strip to the
// other.
import { canvasSourceKey as sourceKey } from '@dorkos/shared/canvas-source-key';
import { MAX_CANVAS_DOCUMENTS } from '@/layers/shared/lib/constants';
import { canvasViewForContent, type CanvasView } from '@dorkos/shared/canvas-view';
import type { AppState } from './app-store-types';

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

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
   * Whether somebody pinned this document.
   *
   * Carried from the server's row because the CAP is over unpinned documents
   * only, on both sides. Without it this window counted pinned rows toward the
   * twelve and evicted locally what the server keeps — which the next hydrate
   * simply put back (DOR-2006 review, finding 10a).
   */
  pinned: boolean;
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

/**
 * A canvas web document's embedded-browser navigation history (DOR-252).
 *
 * Lifted out of {@link CanvasBrowserContent} so it survives the renderer remount
 * that a document-tab switch forces (the browser is keyed on document + content
 * identity, ADR DOR-233, so a plain tab switch remounts it and would otherwise
 * reset in-page back/forward history). Keyed by `documentId` in
 * {@link CanvasSlice.browserHistories}.
 *
 * Scope is deliberately in-memory only (never persisted): the stack holds
 * LOGICAL targets, and each navigation re-mints a fresh signed serve/proxy URL
 * whose token expires — persisting a stack across a full page reload would
 * restore dead references. The canvas persistence layer stores documents, not
 * transient nav state, so on reload each browser reseeds from its `content.url`.
 */
export interface BrowserHistoryState {
  /**
   * The document's `content.url` when this stack was seeded. A later
   * agent-driven url change (`update_canvas` / reopen at a new url) leaves this
   * mismatched, which the browser reads on remount as the signal to discard the
   * stale stack and reseed — preserving the DOR-233 remount-resets-history
   * semantic without coupling the store to the renderer key.
   */
  contentUrl: string;
  /** Visited logical targets, oldest → newest (never signed token URLs). */
  stack: string[];
  /** Index into {@link stack} of the currently-shown page. */
  cursor: number;
}

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface CanvasSlice {
  canvasOpen: boolean;
  setCanvasOpen: (open: boolean) => void;

  /** All open documents of BOTH views, in open order (tab order within a view). */
  openDocuments: CanvasDocument[];
  /**
   * Id of the Canvas view's active document, or null when that view holds none.
   * Non-null whenever the Canvas view has at least one document.
   */
  activeCanvasDocumentId: string | null;
  /**
   * Id of the Browser view's active document, or null when that view holds none.
   * Non-null whenever the Browser view has at least one document.
   */
  activeBrowserDocumentId: string | null;

  /**
   * Append a document for `content` and activate it IN ITS OWN VIEW, leaving the
   * other view's active document exactly where it was. Dedups by source key
   * (`sourcePath`/`src`/`url`/`uri`): re-activates and refreshes an existing
   * document rather than opening a duplicate — but preserves the existing
   * document's content while it is being edited, holding the push on
   * {@link CanvasDocument.heldUpdate} instead (edit-protection). Evicts the
   * least-recently-active document when over {@link MAX_CANVAS_DOCUMENTS}.
   */
  openCanvasDocument: (content: UiCanvasContent) => void;
  /**
   * Mutate the active document of the view `content` belongs to (the agent
   * `update_canvas` path) — a `url` push acts on the Browser tab, a markdown
   * push on the Canvas tab. A no-op when that view has none open; while that
   * document is being edited the push is HELD on
   * {@link CanvasDocument.heldUpdate} rather than dropped, so the canvas can
   * offer it (ADR-0292).
   */
  updateActiveDocument: (content: UiCanvasContent) => void;
  /**
   * Take a held agent push: it becomes the document's content, the hold is
   * cleared, and the edit ends — the person chose the other version, so keeping
   * their draft protected against the version they just accepted would leave
   * them looking at neither. The canvas banner's "Reload".
   */
  applyHeldUpdate: (id: string) => void;
  /**
   * Drop a held agent push and keep editing. The canvas banner's "Keep mine".
   */
  discardHeldUpdate: (id: string) => void;
  /**
   * Write one document's content unconditionally, by id (the in-canvas editor's
   * own write + conflict-reload path). Unlike {@link updateActiveDocument} this
   * ignores edit-protection because the editor IS the protected writer, and it
   * is id-scoped rather than active-scoped so the caller names the document it
   * is rendering instead of whichever view happens to be in front.
   */
  setDocumentContent: (id: string, content: UiCanvasContent) => void;
  /** Close a document by id, activating the most-recently-active one left in ITS view. */
  closeCanvasDocument: (id: string) => void;
  /** Activate an already-open document by id, within its own view. */
  activateCanvasDocument: (id: string) => void;
  /**
   * Set a specific document's edit-protection flag by id. Id-scoped (not
   * active-scoped) so an editor can clear its OWN document's flag on unmount —
   * e.g. after a tab switch has already changed the active document — instead of
   * leaving it stuck `true` and permanently dropping agent updates to it.
   */
  setDocumentEditing: (id: string, editing: boolean) => void;

  /**
   * Per-document embedded-browser navigation history, keyed by document id
   * (DOR-252). In-memory only — never persisted (see {@link BrowserHistoryState}).
   * Entries are pruned in every document-removal path so the map never outgrows
   * the open-document set.
   */
  browserHistories: Record<string, BrowserHistoryState>;
  /**
   * Write a document's browser navigation history (write-through on every
   * in-page nav). A no-op when the document is no longer open, so a nav that
   * commits the same tick its document is closed can never resurrect a pruned
   * entry.
   */
  writeBrowserHistory: (documentId: string, entry: BrowserHistoryState) => void;

  canvasPreferredWidth: number | null;
  setCanvasPreferredWidth: (width: number | null) => void;
  /**
   * The session whose canvas this slice is holding, or null before one is
   * bound. Every write-through names it, so a write can never land on the
   * session the reader has just left.
   */
  canvasSessionId: string | null;
  /**
   * Bind the slice to a session and empty it, ready for the snapshot to fill.
   *
   * A RESET rather than a read: the table comes from `snapshot.canvas` on the
   * session stream's cold connect, the same place messages and status come from
   * (spec `canvas-agent-seat` §1.5).
   */
  loadCanvasForSession: (sessionId: string) => void;
  /**
   * Fill the slice from the session stream's cold snapshot.
   *
   * Authoritative as a SET: it REPLACES what this window holds rather than
   * merging, which is what makes a close it missed while disconnected
   * self-correct. The two view-active ids are re-derived rather than dropped —
   * a reconnect is not a reason to forget which tab somebody was on.
   *
   * @param sessionId - The session the snapshot belongs to. A snapshot for any
   *   other session is ignored: a window that has moved on must not be filled
   *   with the table it just left.
   * @param documents - The server's rows, pinned first then most recent.
   */
  hydrateCanvasFromSnapshot: (
    sessionId: string,
    documents: readonly ServerCanvasDocument[]
  ) => void;
  /**
   * Apply one `canvas` event from the session's stream.
   *
   * @param sessionId - The session the STREAM belongs to. An event for any other
   *   session is ignored.
   * @param event - The frame: a whole document, or an id and `closed`.
   */
  applyCanvasEvent: (
    sessionId: string,
    event: {
      documentId: string;
      document?: ServerCanvasDocument;
      closed?: boolean;
      change?: 'opened' | 'updated' | 'activated' | 'pinned';
    }
  ) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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
function sourceLabel(content: UiCanvasContent): string {
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

/** Generate a stable document id. */
function makeDocumentId(): string {
  return crypto.randomUUID();
}

/** The open documents belonging to one view, in tab order. */
export function documentsInView(documents: CanvasDocument[], view: CanvasView): CanvasDocument[] {
  return documents.filter((d) => canvasViewForContent(d.content) === view);
}

/** The two per-view active document ids, as the store holds them. */
interface ActiveIds {
  activeCanvasDocumentId: string | null;
  activeBrowserDocumentId: string | null;
}

/**
 * Re-derive both active ids against a document list, so neither view is ever
 * left pointing at a document that is gone while still holding tabs.
 *
 * An id that still names an open document of its own view is kept; otherwise the
 * view falls back to its most-recently-active remaining document, and to null
 * only when it has none. Called on close and on hydration — a stranded id would
 * render a tab strip above the empty-state splash. The open path needs no such
 * repair because {@link evictToCapacity} never drops a document a view is
 * showing.
 */
function reconcileActiveIds(documents: CanvasDocument[], current: ActiveIds): ActiveIds {
  const resolve = (view: CanvasView, id: string | null): string | null => {
    const inView = documentsInView(documents, view);
    if (id && inView.some((d) => d.id === id)) return id;
    const mostRecent = [...inView].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    return mostRecent?.id ?? null;
  };
  return {
    activeCanvasDocumentId: resolve('canvas', current.activeCanvasDocumentId),
    activeBrowserDocumentId: resolve('browser', current.activeBrowserDocumentId),
  };
}

/**
 * Enforce the open-document cap by dropping the least-recently-active UNPINNED
 * documents, never one being edited and never one a view is showing.
 *
 * **The same rule the server applies to the same table** (`evict` in
 * `services/canvas/canvas-service.ts`), which is what makes this an optimistic
 * preview of the server's answer rather than a second opinion: the cap counts
 * unpinned documents only, pinned rows are neither counted nor dropped, and the
 * front document of each view is protected on both sides. When the two
 * disagreed, a thirteenth open had each drop a different row and the window
 * ended up missing one until the next hydrate.
 *
 * The cap is over BOTH views together: twelve open documents is twelve, however
 * they are split between the tabs. That is exactly why **both** active ids are
 * protected rather than only the just-opened one. `lastActiveAt` moves when a
 * document is opened or activated, not when the reader switches tabs, so the
 * page somebody is sitting on in Browser goes stale the moment an agent opens
 * twelve documents in Canvas — and the LRU would take the one document on
 * screen.
 *
 * @param documents - The open set, including the document just added.
 * @param protectedIds - Ids that may never be evicted: the just-opened document
 *   and each view's active one. Nulls are ignored.
 */
function evictToCapacity(
  documents: CanvasDocument[],
  protectedIds: readonly (string | null)[]
): CanvasDocument[] {
  const dropCount = documents.filter((d) => !d.pinned).length - MAX_CANVAS_DOCUMENTS;
  if (dropCount <= 0) return documents;
  const keep = new Set(protectedIds.filter((id): id is string => id !== null));
  const evictable = documents
    .filter((d) => !d.pinned && !keep.has(d.id) && !d.editing)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  const dropIds = new Set(evictable.slice(0, dropCount).map((d) => d.id));
  return documents.filter((d) => !dropIds.has(d.id));
}

/**
 * Drop browser-history entries whose document is no longer open. Called from
 * every document-removal path (explicit close, LRU eviction) so the history map
 * stays bounded by the open-document set. Returns the SAME reference when
 * nothing was pruned, so unrelated document mutations don't churn the map.
 */
function pruneBrowserHistories(
  histories: Record<string, BrowserHistoryState>,
  documents: CanvasDocument[]
): Record<string, BrowserHistoryState> {
  const liveIds = new Set(documents.map((d) => d.id));
  const survivors = Object.entries(histories).filter(([id]) => liveIds.has(id));
  if (survivors.length === Object.keys(histories).length) return histories;
  return Object.fromEntries(survivors);
}

// ---------------------------------------------------------------------------
// The write-through seam
// ---------------------------------------------------------------------------

/** The six transport methods this slice needs, and nothing else. */
export type SessionCanvasTransport = Pick<
  Transport,
  | 'listSessionCanvas'
  | 'getSessionCanvasDocument'
  | 'openSessionCanvasDocument'
  | 'updateSessionCanvasDocument'
  | 'closeSessionCanvasDocument'
  | 'setSessionCanvasEditing'
>;

/** How this slice reaches the server. Set by `TransportProvider`. */
let canvasTransport: SessionCanvasTransport | null = null;

/**
 * Tell the canvas slice how to reach the server.
 *
 * **Set from `TransportProvider`, which both shells pass through**, rather than
 * from each app entry — the same reasoning `CanvasService` uses for wiring its
 * listeners at module scope: one root owns it, and a third shell cannot forget.
 * A zustand store is not a React consumer, so it cannot read the context itself.
 *
 * @param transport - The transport, or `null` to unbind (tests).
 */
export function setSessionCanvasTransport(transport: SessionCanvasTransport | null): void {
  canvasTransport = transport;
}

/** How often a focused editor refreshes its claim on a document (server TTL is 45s). */
const EDIT_HEARTBEAT_MS = 15_000;

/** The live edit-lock heartbeats, keyed by document id. */
const editHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

/** Stop refreshing a document's edit lock, if this window was. */
function stopHeartbeat(documentId: string): void {
  const timer = editHeartbeats.get(documentId);
  if (timer === undefined) return;
  clearInterval(timer);
  editHeartbeats.delete(documentId);
}

/**
 * Say out loud that a canvas change did not land.
 *
 * A write that failed and said nothing would leave this window showing a
 * document the server does not have — which is the divergence the whole move to
 * the server removes, reappearing one layer up.
 */
function reportWriteFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : 'The canvas could not be changed.';
  toast.error('That did not reach your canvas', { description: message });
}

/** A `pending:` id belongs to a row this window minted and has not heard back about. */
function isPendingId(id: string): boolean {
  return id.startsWith('pending:');
}

/**
 * Fold one of the server's rows into the shape this slice holds, keeping the
 * per-viewer fields of the row it replaces.
 *
 * `editing` and `heldUpdate` are this window's own and never the server's, so
 * they survive every arrival — a document somebody is typing in must not lose
 * their draft because a frame landed.
 */
function fromServer(row: ServerCanvasDocument, previous?: CanvasDocument): CanvasDocument {
  return {
    id: row.id,
    rev: row.rev,
    content: row.content,
    openedAt: Date.parse(row.openedAt),
    lastActiveAt: Date.parse(row.lastActiveAt),
    sourceLabel: row.title || sourceLabel(row.content),
    pinned: row.pinned,
    editing: previous?.editing ?? false,
    heldUpdate: previous?.heldUpdate ?? null,
  };
}

// ---------------------------------------------------------------------------
// Slice creator
// ---------------------------------------------------------------------------

/** Creates the canvas slice — the server's table, as this window holds it. */
export const createCanvasSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  CanvasSlice
> = (set, get) => {
  /**
   * Run one write against the session this slice is bound to, and put the local
   * table back the way it was if it fails.
   *
   * Bound to the session id captured at the moment the write STARTED: a write
   * that answers after the reader has moved to another session must not be
   * applied to the table they are now looking at.
   */
  function writeThrough(
    sessionId: string | null,
    write: (transport: SessionCanvasTransport, sessionId: string) => Promise<unknown>,
    revert: () => void
  ): void {
    const transport = canvasTransport;
    // No transport bound — a test, or a shell with no server. The optimistic
    // apply stands on its own, which is exactly what this slice used to do.
    if (!transport || sessionId === null) return;
    void write(transport, sessionId).catch((err: unknown) => {
      if (get().canvasSessionId === sessionId) revert();
      reportWriteFailure(err);
    });
  }

  /**
   * Replace a pending row with the row the server answered with.
   *
   * Matched on the pending id this window minted rather than on the source key:
   * `json` and `widget` have no key, and two of them opened in the same tick
   * would otherwise adopt each other's rows.
   */
  function settlePending(pendingId: string, row: ServerCanvasDocument): void {
    set((s) => {
      const previous = s.openDocuments.find((d) => d.id === pendingId);
      if (!previous) return {};
      // Another window may already have delivered this row through the stream.
      // Adopt rather than duplicate: drop the pending row and keep the real one.
      const already = s.openDocuments.find((d) => d.id === row.id && d.id !== pendingId);
      const documents = already
        ? s.openDocuments.filter((d) => d.id !== pendingId)
        : s.openDocuments.map((d) => (d.id === pendingId ? fromServer(row, previous) : d));
      const swapId = (id: string | null) => (id === pendingId ? row.id : id);
      return {
        openDocuments: documents,
        activeCanvasDocumentId: swapId(s.activeCanvasDocumentId),
        activeBrowserDocumentId: swapId(s.activeBrowserDocumentId),
        browserHistories: renameBrowserHistory(s.browserHistories, pendingId, row.id),
      };
    });
  }

  return {
    canvasOpen: false,
    setCanvasOpen: (open) => set({ canvasOpen: open }),

    openDocuments: [],
    activeCanvasDocumentId: null,
    activeBrowserDocumentId: null,

    browserHistories: {},
    writeBrowserHistory: (documentId, entry) =>
      set((s) => {
        // Guard against resurrecting a removed document's history: a late
        // write-through (a nav committed the same tick the document closed) must
        // not re-add an entry that a removal path already pruned.
        if (!s.openDocuments.some((d) => d.id === documentId)) return {};
        return { browserHistories: { ...s.browserHistories, [documentId]: entry } };
      }),

    openCanvasDocument: (content) => {
      const before = get();
      const sessionId = before.canvasSessionId;
      const key = sourceKey(content);
      const existingIdx = key
        ? before.openDocuments.findIndex((d) => sourceKey(d.content) === key)
        : -1;
      const existing = existingIdx >= 0 ? before.openDocuments[existingIdx] : undefined;
      const pendingId = existing ? existing.id : `pending:${makeDocumentId()}`;

      set((s) => {
        const now = Date.now();
        let documents: CanvasDocument[];
        if (existing) {
          // Re-activate; refresh content + label unless the doc is being edited,
          // in which case hold the push for the banner instead of losing it. A
          // push that LANDS clears any hold — the same rule
          // `updateActiveDocument` follows, and for the same reason: an older
          // version left on offer would let Reload replace what is on screen
          // with something staler than it.
          const refreshed: CanvasDocument = existing.editing
            ? { ...existing, heldUpdate: content, lastActiveAt: now }
            : {
                ...existing,
                content,
                sourceLabel: sourceLabel(content),
                heldUpdate: null,
                lastActiveAt: now,
              };
          documents = s.openDocuments.map((d) => (d.id === existing.id ? refreshed : d));
        } else {
          const doc: CanvasDocument = {
            id: pendingId,
            rev: 0,
            content,
            openedAt: now,
            lastActiveAt: now,
            sourceLabel: sourceLabel(content),
            // Nothing this window mints is pinned: the POST does not ask for it
            // and the server answers `pinned: false`.
            pinned: false,
            editing: false,
            heldUpdate: null,
          };
          // Neither view may lose the document it is showing to make room for
          // this one, so both active ids are protected alongside it.
          documents = evictToCapacity(
            [...s.openDocuments, doc],
            [pendingId, s.activeCanvasDocumentId, s.activeBrowserDocumentId]
          );
        }
        // Only the view this content belongs to changes what it is showing; the
        // other view stays on whatever the reader left there, and eviction
        // cannot have taken it.
        const activeIds =
          canvasViewForContent(content) === 'browser'
            ? {
                activeCanvasDocumentId: s.activeCanvasDocumentId,
                activeBrowserDocumentId: pendingId,
              }
            : {
                activeCanvasDocumentId: pendingId,
                activeBrowserDocumentId: s.activeBrowserDocumentId,
              };
        return {
          openDocuments: documents,
          ...activeIds,
          // LRU eviction may have dropped documents — prune their histories too.
          browserHistories: pruneBrowserHistories(s.browserHistories, documents),
        };
      });

      writeThrough(
        sessionId,
        async (transport, id) => {
          const row = await transport.openSessionCanvasDocument(id, content);
          settlePending(pendingId, row);
        },
        // **Two reverts, because there were two applies.** A refused open of a
        // document that was ALREADY there — a routine 409 while somebody is
        // editing it — must put that document's previous content back, never
        // remove a row the server still holds. Only the fresh branch minted a
        // row nobody else has, and only it may take one away.
        existing
          ? () => restoreContent(set, existing.id, existing.content)
          : () =>
              set((s) => {
                const documents = s.openDocuments.filter((d) => d.id !== pendingId);
                return {
                  openDocuments: documents,
                  ...reconcileActiveIds(documents, s),
                  browserHistories: pruneBrowserHistories(s.browserHistories, documents),
                };
              })
      );
    },

    updateActiveDocument: (content) => {
      const before = get();
      // The push lands in the view its content belongs to, so a `url` update
      // never overwrites the document somebody is reading in the Canvas tab.
      const targetId =
        canvasViewForContent(content) === 'browser'
          ? before.activeBrowserDocumentId
          : before.activeCanvasDocumentId;
      const target = before.openDocuments.find((d) => d.id === targetId);
      if (!target) return;

      set((s) => ({
        openDocuments: s.openDocuments.map((d) => {
          if (d.id !== target.id) return d;
          // Protect the edit (ADR-0292) — but HOLD the push for the banner
          // instead of dropping it, which is what this did in silence until
          // notify-and-reconcile landed.
          if (d.editing) return { ...d, heldUpdate: content };
          // Not editing: the push lands, and a hold left over from an earlier
          // edit is stale — a newer version is the document's content now.
          return { ...d, content, sourceLabel: sourceLabel(content), heldUpdate: null };
        }),
      }));

      // A held push is this window's own offer and was never applied, so there
      // is nothing to write through for it.
      if (target.editing || isPendingId(target.id)) return;
      const previous = target.content;
      writeThrough(
        before.canvasSessionId,
        (transport, id) => transport.updateSessionCanvasDocument(id, target.id, { content }),
        () => restoreContent(set, target.id, previous)
      );
    },

    applyHeldUpdate: (id) => {
      const before = get();
      const target = before.openDocuments.find((d) => d.id === id);
      if (!target?.heldUpdate) return;
      const content = target.heldUpdate;
      const previous = target.content;
      set((s) => ({
        openDocuments: s.openDocuments.map((d) =>
          d.id === id
            ? { ...d, content, sourceLabel: sourceLabel(content), heldUpdate: null, editing: false }
            : d
        ),
      }));
      stopHeartbeat(id);
      if (isPendingId(id)) return;
      writeThrough(
        before.canvasSessionId,
        (transport, sessionId) => transport.updateSessionCanvasDocument(sessionId, id, { content }),
        () => restoreContent(set, id, previous)
      );
    },

    discardHeldUpdate: (id) =>
      set((s) => {
        if (!s.openDocuments.some((d) => d.id === id && d.heldUpdate)) return {};
        // `heldUpdate` is this window's own and never the server's, so there is
        // nothing to write: the draft the person kept is the editor's, and the
        // editor owns writing it.
        return {
          openDocuments: s.openDocuments.map((d) => (d.id === id ? { ...d, heldUpdate: null } : d)),
        };
      }),

    setDocumentContent: (id, content) => {
      const before = get();
      const target = before.openDocuments.find((d) => d.id === id);
      if (!target) return;
      const previous = target.content;
      // A content write never moves a document between views:
      // `openCanvasDocument` only ever refreshes from a source key of its own
      // view, and `updateActiveDocument` picks its target by the content's view.
      set((s) => ({
        openDocuments: s.openDocuments.map((d) =>
          d.id === id ? { ...d, content, sourceLabel: sourceLabel(content) } : d
        ),
      }));
      if (isPendingId(id)) return;
      writeThrough(
        before.canvasSessionId,
        (transport, sessionId) => transport.updateSessionCanvasDocument(sessionId, id, { content }),
        () => restoreContent(set, id, previous)
      );
    },

    closeCanvasDocument: (id) => {
      const before = get();
      const closed = before.openDocuments.find((d) => d.id === id);
      if (!closed) return;
      stopHeartbeat(id);
      set((s) => {
        const documents = s.openDocuments.filter((d) => d.id !== id);
        // Closing the active document hands that view its most-recently-active
        // survivor; the other view is untouched.
        return {
          openDocuments: documents,
          ...reconcileActiveIds(documents, s),
          browserHistories: pruneBrowserHistories(s.browserHistories, documents),
        };
      });
      if (isPendingId(id)) return;
      writeThrough(
        before.canvasSessionId,
        (transport, sessionId) => transport.closeSessionCanvasDocument(sessionId, id),
        () =>
          set((s) => {
            if (s.openDocuments.some((d) => d.id === id)) return {};
            const documents = [...s.openDocuments, closed];
            return { openDocuments: documents, ...reconcileActiveIds(documents, s) };
          })
      );
    },

    activateCanvasDocument: (id) => {
      const before = get();
      const target = before.openDocuments.find((d) => d.id === id);
      if (!target) return;
      set((s) => {
        const documents = s.openDocuments.map((d) =>
          d.id === id ? { ...d, lastActiveAt: Date.now() } : d
        );
        const activeIds =
          canvasViewForContent(target.content) === 'browser'
            ? { activeCanvasDocumentId: s.activeCanvasDocumentId, activeBrowserDocumentId: id }
            : { activeCanvasDocumentId: id, activeBrowserDocumentId: s.activeBrowserDocumentId };
        return { openDocuments: documents, ...activeIds };
      });
      if (isPendingId(id)) return;
      // Written through because recency is what the SERVER's LRU evicts on: a
      // document somebody keeps coming back to on one device must not be dropped
      // because another device opened twelve things. It changes the order and
      // nobody else's open tab — which view each window is showing stays here.
      writeThrough(
        before.canvasSessionId,
        (transport, sessionId) =>
          transport.updateSessionCanvasDocument(sessionId, id, {
            activate: true,
          } satisfies UpdateCanvasDocumentRequest),
        () => undefined
      );
    },

    setDocumentEditing: (id, editing) => {
      const before = get();
      if (!before.openDocuments.some((d) => d.id === id)) return;
      // `editing` is this window's own: transient, never hydrated, never sent as
      // state. What IS sent is the edit LOCK, which is what holds the agent's
      // push back while somebody is typing.
      set((s) => ({
        openDocuments: s.openDocuments.map((d) => (d.id === id ? { ...d, editing } : d)),
      }));
      stopHeartbeat(id);
      if (isPendingId(id)) return;
      const sessionId = before.canvasSessionId;
      const transport = canvasTransport;
      if (!transport || sessionId === null) return;
      const beat = (): void => {
        void transport.setSessionCanvasEditing(sessionId, id, editing).catch(() => {
          // A dropped heartbeat is not worth a toast: the lock lapses on its own
          // 45 seconds after the last one that landed, which is the whole point
          // of evaluating it lazily. Stop refreshing rather than keep failing.
          stopHeartbeat(id);
        });
      };
      beat();
      // Refreshed while the editor stays focused; the server's TTL is three
      // times this, so one dropped request never drops a lock mid-sentence.
      if (editing) editHeartbeats.set(id, setInterval(beat, EDIT_HEARTBEAT_MS));
    },

    canvasPreferredWidth: null,
    setCanvasPreferredWidth: (width) => set({ canvasPreferredWidth: width }),

    canvasSessionId: null,

    loadCanvasForSession: (sessionId) => {
      for (const documentId of [...editHeartbeats.keys()]) stopHeartbeat(documentId);
      set({
        canvasOpen: false,
        openDocuments: [],
        activeCanvasDocumentId: null,
        activeBrowserDocumentId: null,
        canvasSessionId: sessionId,
        // Browser history is in-memory only; a session switch starts fresh so it
        // never carries the previous session's histories (and never unbounded).
        browserHistories: {},
      });
    },

    hydrateCanvasFromSnapshot: (sessionId, documents) =>
      set((s) => {
        if (s.canvasSessionId !== sessionId) return {};
        const previous = new Map(s.openDocuments.map((d) => [d.id, d]));
        const hydrated = documents.map((row) => fromServer(row, previous.get(row.id)));
        return {
          openDocuments: hydrated,
          // Re-derived rather than dropped: a reconnect is not a reason to
          // forget which tab somebody was on, and a stranded id would render a
          // tab strip above the empty-state splash.
          ...reconcileActiveIds(hydrated, s),
          canvasOpen: s.canvasOpen || hydrated.length > 0,
          browserHistories: pruneBrowserHistories(s.browserHistories, hydrated),
        };
      }),

    applyCanvasEvent: (sessionId, event) =>
      set((s) => {
        if (s.canvasSessionId !== sessionId) return {};
        if (event.closed === true || !event.document) {
          if (!s.openDocuments.some((d) => d.id === event.documentId)) return {};
          const documents = s.openDocuments.filter((d) => d.id !== event.documentId);
          return {
            openDocuments: documents,
            ...reconcileActiveIds(documents, s),
            browserHistories: pruneBrowserHistories(s.browserHistories, documents),
          };
        }
        const row = event.document;
        const held = s.openDocuments.find((d) => d.id === row.id);
        if (held) {
          // **A lower `rev` never overwrites a higher one.** This is what makes
          // the echo of this window's own write harmless and makes a second
          // device's write win in order.
          if (row.rev <= held.rev) return {};
          // The edit lock's job: while somebody is typing in this document, an
          // arrival is HELD for the banner rather than landing underneath them.
          if (held.editing) {
            return {
              openDocuments: s.openDocuments.map((d) =>
                d.id === row.id ? { ...d, rev: row.rev, heldUpdate: row.content } : d
              ),
            };
          }
          return {
            openDocuments: s.openDocuments.map((d) => (d.id === row.id ? fromServer(row, d) : d)),
          };
        }
        // A document another window opened. It appears in its own view without
        // moving what THIS window is looking at — a shared table that yanked
        // somebody's tab would be over-participation one layer down.
        const documents = evictToCapacity(
          [...s.openDocuments, fromServer(row)],
          [s.activeCanvasDocumentId, s.activeBrowserDocumentId]
        );
        return {
          openDocuments: documents,
          ...reconcileActiveIds(documents, s),
          browserHistories: pruneBrowserHistories(s.browserHistories, documents),
        };
      }),
  };
};

/** Put one document's content back after a write the server refused. */
function restoreContent(
  set: (updater: (state: AppState) => Partial<AppState>) => void,
  id: string,
  content: UiCanvasContent
): void {
  set((s) => ({
    openDocuments: s.openDocuments.map((d) =>
      d.id === id ? { ...d, content, sourceLabel: sourceLabel(content) } : d
    ),
  }));
}

/**
 * Move a browser history entry from a pending id onto the id the server gave.
 *
 * Returns the SAME reference when there is nothing to move, so a settle that
 * touches no history does not churn the map.
 */
function renameBrowserHistory(
  histories: Record<string, BrowserHistoryState>,
  from: string,
  to: string
): Record<string, BrowserHistoryState> {
  const entry = histories[from];
  if (entry === undefined) return histories;
  const { [from]: _moved, ...rest } = histories;
  return { ...rest, [to]: entry };
}
