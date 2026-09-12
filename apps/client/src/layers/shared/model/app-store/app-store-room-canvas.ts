/**
 * Room canvas slice — the table a room owns, as this browser holds it (spec
 * `room-canvas` §9.2).
 *
 * Deliberately NOT merged with {@link import('./app-store-canvas').CanvasSlice}.
 * The session canvas is one browser's private surface, persisted per session in
 * `localStorage`. A room's table is the SERVER's: it is the same for every
 * viewer, it survives this browser being closed, and a copy of it kept here
 * would recreate the exact divergence this feature exists to remove. So
 * **nothing in this slice is ever persisted**, and every document in it came off
 * the room's own stream.
 *
 * Three rules make a viewer's screen agree with the server's table:
 *
 * 1. **A frame carries whole state, never a delta** (§2), so a reader who missed
 *    five frames and caught the sixth is correct again.
 * 2. **A lower `rev` never overwrites a higher one.** `rev` is what orders two
 *    frames racing for one document; it is deliberately not a stream cursor.
 * 3. **A stream cycle starts from nothing.** A close is a DELETION, so a
 *    document taken off the table while this reader was disconnected leaves no
 *    trace on the log to replay — nothing but a re-send of everything still
 *    there can correct it. The server sends exactly that on every resume (the
 *    canvas resync), so a reader clears the room's table when a subscription
 *    cycle begins and rebuilds it from the burst that follows. Merging instead
 *    would leave a closed document on screen forever.
 *
 * What is NOT the server's is which document each of this viewer's two views is
 * showing, and which arrivals they have not looked at yet. Those are per-viewer
 * and live here: a shared table that yanked everybody's tab would be
 * over-participation one layer down (§9.3).
 *
 * @module shared/model/app-store-room-canvas
 */
import type { StateCreator } from 'zustand';
import type { CanvasDocument, RoomCanvasEvent } from '@dorkos/shared/room-schemas';
import { canvasViewForContent, type CanvasView } from '@/layers/shared/lib/canvas-view';
import type { AppState } from './app-store-types';

/** Which document each of the two views is showing, for one room. */
export interface RoomCanvasActiveIds {
  /** The Canvas view's active document, or null when it holds none. */
  canvas: string | null;
  /** The Browser view's active document, or null when it holds none. */
  browser: string | null;
}

/** Documents this viewer has not looked at yet, in one room, per view. */
export interface RoomCanvasUnread {
  /** Ids of unlooked-at documents in the Canvas view. */
  canvas: readonly string[];
  /** Ids of unlooked-at documents in the Browser view. */
  browser: readonly string[];
}

const NO_ACTIVE: RoomCanvasActiveIds = { canvas: null, browser: null };
const NO_UNREAD: RoomCanvasUnread = { canvas: [], browser: [] };

export interface RoomCanvasSlice {
  /**
   * Every room's table, keyed by room id — the server's rows, verbatim.
   *
   * Keyed rather than single-room so switching between two rooms does not throw
   * away the table of the one being left: a room's stream stays subscribed while
   * its page is mounted, and a viewer who walks back finds the table they left.
   */
  roomCanvasDocuments: Readonly<Record<string, readonly CanvasDocument[]>>;
  /** Which document each view is showing, per room. Per-viewer, never the server's. */
  roomCanvasActive: Readonly<Record<string, RoomCanvasActiveIds>>;
  /** Documents that arrived while this viewer was looking somewhere else, per room. */
  roomCanvasUnread: Readonly<Record<string, RoomCanvasUnread>>;
  /**
   * The document this viewer is editing in each room, or absent — what the edit
   * lock heartbeat is about, and the one thing no arrival may move them off.
   */
  roomCanvasEditing: Readonly<Record<string, string | null>>;
  /**
   * The room whose table is live in this browser right now, or null off a room
   * route.
   *
   * Written by the room stream, which is the one thing that knows — it is opened
   * for exactly the room on screen and closed when that screen goes away. The
   * right panel's tab strip reads it to decide whose unread dot to draw, and
   * reads it from HERE rather than resolving the route itself: the strip renders
   * in the embed and in tests with no transport and no router behind it, and a
   * tab that resolved a room would take both of those down with it.
   */
  roomCanvasLiveRoomId: string | null;

  /**
   * A subscription cycle is starting: forget this room's table, because what is
   * on it is now unknown.
   *
   * The resync burst that follows the resume rebuilds it. Clearing rather than
   * merging is what makes a close this reader missed self-correct — see rule 3
   * above. The viewer's own active ids and unread marks are kept: they are
   * per-viewer facts about attention, and a reconnect is not a reason to forget
   * which tab somebody was on.
   *
   * @param roomId - The room whose stream is (re)connecting.
   */
  beginRoomCanvasCycle: (roomId: string) => void;

  /**
   * Apply one `canvas` frame from a room's stream.
   *
   * @param roomId - The room the STREAM belongs to. A frame naming any other
   *   room's document is ignored — the slice is keyed by room, and writing one
   *   room's stream into another's table is the bug that would be hardest to
   *   see.
   * @param event - The frame.
   * @param viewerAuthorId - Who is reading, or null when the room's roster has
   *   not landed yet. An open activates the new document only in the view of the
   *   member who AUTHORED it (§9.3); for everybody else the tab appears with an
   *   unread mark and the active tab does not move.
   */
  applyRoomCanvasFrame: (
    roomId: string,
    event: RoomCanvasEvent,
    viewerAuthorId: string | null
  ) => void;

  /**
   * Show a document in its own view, and mark it looked at.
   *
   * Purely local: the server's `activate` changes the ORDER, not anybody's open
   * tab, so choosing a tab here tells the server nothing.
   *
   * @param roomId - The room.
   * @param documentId - The document to show.
   */
  activateRoomCanvasDocument: (roomId: string, documentId: string) => void;

  /**
   * Mark everything in one view looked at — what the panel calls when the reader
   * arrives on that tab.
   *
   * @param roomId - The room.
   * @param view - Which of the two views they are looking at.
   */
  clearRoomCanvasUnread: (roomId: string, view: CanvasView) => void;

  /**
   * Record that this viewer is editing a document in this room, or has stopped.
   *
   * @param roomId - The room.
   * @param documentId - The document being edited, or null when the edit ended.
   */
  setRoomCanvasEditing: (roomId: string, documentId: string | null) => void;

  /**
   * Say which room's table is live in this browser, or that none is.
   *
   * @param roomId - The room on screen, or null when the reader has left one.
   */
  setRoomCanvasLiveRoom: (roomId: string | null) => void;
}

/** The documents of one room's table that belong to one view, pinned first. */
export function roomDocumentsInView(
  documents: readonly CanvasDocument[],
  view: CanvasView
): CanvasDocument[] {
  return documents.filter((d) => canvasViewForContent(d.content) === view);
}

/**
 * The table's tab order: pinned documents first, then by when they were opened.
 *
 * Pinned-first is the whole point of a pin — it is what "this one matters" means
 * on a strip that the least-recently-active document falls off the end of. Ties
 * break on `openedAt` so the order is stable across re-renders and identical for
 * every viewer, rather than depending on whose frame arrived first.
 */
function tabOrder(a: CanvasDocument, b: CanvasDocument): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0;
}

/** Sort a room's table into tab order, leaving the caller's array alone. */
function sorted(documents: readonly CanvasDocument[]): CanvasDocument[] {
  return [...documents].sort(tabOrder);
}

/**
 * Re-derive both views' active ids against a table, so neither view is left
 * pointing at a document that is gone while still holding tabs.
 *
 * An id that still names a document of its own view is kept; otherwise the view
 * falls back to that view's first document in tab order, and to null only when
 * it has none. The mirror of the session canvas's own reconcile, and for the
 * same reason: a stranded id renders a tab strip above an empty state.
 */
function reconcileActive(
  documents: readonly CanvasDocument[],
  current: RoomCanvasActiveIds
): RoomCanvasActiveIds {
  const resolve = (view: CanvasView, id: string | null): string | null => {
    const inView = roomDocumentsInView(documents, view);
    if (id !== null && inView.some((d) => d.id === id)) return id;
    return inView.sort(tabOrder)[0]?.id ?? null;
  };
  return {
    canvas: resolve('canvas', current.canvas),
    browser: resolve('browser', current.browser),
  };
}

/** Drop unread marks for documents that are no longer on the table. */
function pruneUnread(
  unread: RoomCanvasUnread,
  documents: readonly CanvasDocument[]
): RoomCanvasUnread {
  const live = new Set(documents.map((d) => d.id));
  return {
    canvas: unread.canvas.filter((id) => live.has(id)),
    browser: unread.browser.filter((id) => live.has(id)),
  };
}

/** Add a document id to one view's unread list, without duplicating it. */
function withUnread(unread: RoomCanvasUnread, view: CanvasView, id: string): RoomCanvasUnread {
  if (unread[view].includes(id)) return unread;
  return { ...unread, [view]: [...unread[view], id] };
}

/** Remove a document id from both views' unread lists. */
function withoutUnread(unread: RoomCanvasUnread, id: string): RoomCanvasUnread {
  return {
    canvas: unread.canvas.filter((held) => held !== id),
    browser: unread.browser.filter((held) => held !== id),
  };
}

/**
 * Creates the room canvas slice — one room's shared table, live, never
 * persisted.
 */
export const createRoomCanvasSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  RoomCanvasSlice
> = (set) => ({
  roomCanvasDocuments: {},
  roomCanvasActive: {},
  roomCanvasUnread: {},
  roomCanvasEditing: {},
  roomCanvasLiveRoomId: null,

  beginRoomCanvasCycle: (roomId) =>
    set((s) => {
      if ((s.roomCanvasDocuments[roomId] ?? []).length === 0) return {};
      return { roomCanvasDocuments: { ...s.roomCanvasDocuments, [roomId]: [] } };
    }),

  applyRoomCanvasFrame: (roomId, event, viewerAuthorId) =>
    set((s) => {
      // A frame is about the room whose stream carried it. Anything else is a
      // mis-wired subscription, and writing it here would corrupt a table
      // silently rather than fail loudly.
      if (event.document && event.document.roomId !== roomId) return {};

      const held = s.roomCanvasDocuments[roomId] ?? [];
      const active = s.roomCanvasActive[roomId] ?? NO_ACTIVE;
      const unread = s.roomCanvasUnread[roomId] ?? NO_UNREAD;

      if (event.closed === true || !event.document) {
        if (!held.some((d) => d.id === event.documentId)) return {};
        const documents = held.filter((d) => d.id !== event.documentId);
        return {
          roomCanvasDocuments: { ...s.roomCanvasDocuments, [roomId]: documents },
          roomCanvasActive: {
            ...s.roomCanvasActive,
            [roomId]: reconcileActive(documents, active),
          },
          roomCanvasUnread: {
            ...s.roomCanvasUnread,
            [roomId]: withoutUnread(unread, event.documentId),
          },
        };
      }

      const document = event.document;
      const existing = held.find((d) => d.id === document.id);
      // Two frames can race for one document; `rev` is what orders them. An
      // older one arriving late must not put an older version back on screen.
      if (existing && existing.rev > document.rev) return {};

      const documents = sorted(
        existing ? held.map((d) => (d.id === document.id ? document : d)) : [...held, document]
      );
      const view = canvasViewForContent(document.content);

      // Only an OPEN moves a tab, and only for the member who opened it: a
      // person who typed a URL lands on their page. An update, an activate or a
      // pin never moves anybody, and nothing at all moves a viewer who is
      // editing — being pulled off your own half-finished edit is the worst
      // version of this (§9.3).
      const mine = viewerAuthorId !== null && document.authorId === viewerAuthorId;
      const editing = s.roomCanvasEditing[roomId] ?? null;
      const followIt = event.change === 'opened' && mine && editing === null;

      return {
        roomCanvasDocuments: { ...s.roomCanvasDocuments, [roomId]: documents },
        roomCanvasActive: {
          ...s.roomCanvasActive,
          [roomId]: followIt
            ? { ...reconcileActive(documents, active), [view]: document.id }
            : reconcileActive(documents, active),
        },
        roomCanvasUnread: {
          ...s.roomCanvasUnread,
          [roomId]: pruneUnread(
            // A document this viewer is already showing is not unread, and
            // neither is one they just opened themselves.
            followIt || active[view] === document.id
              ? withoutUnread(unread, document.id)
              : withUnread(unread, view, document.id),
            documents
          ),
        },
      };
    }),

  activateRoomCanvasDocument: (roomId, documentId) =>
    set((s) => {
      const held = s.roomCanvasDocuments[roomId] ?? [];
      const target = held.find((d) => d.id === documentId);
      if (!target) return {};
      const active = s.roomCanvasActive[roomId] ?? NO_ACTIVE;
      const view = canvasViewForContent(target.content);
      return {
        roomCanvasActive: { ...s.roomCanvasActive, [roomId]: { ...active, [view]: documentId } },
        roomCanvasUnread: {
          ...s.roomCanvasUnread,
          [roomId]: withoutUnread(s.roomCanvasUnread[roomId] ?? NO_UNREAD, documentId),
        },
      };
    }),

  clearRoomCanvasUnread: (roomId, view) =>
    set((s) => {
      const unread = s.roomCanvasUnread[roomId] ?? NO_UNREAD;
      if (unread[view].length === 0) return {};
      return { roomCanvasUnread: { ...s.roomCanvasUnread, [roomId]: { ...unread, [view]: [] } } };
    }),

  setRoomCanvasEditing: (roomId, documentId) =>
    set((s) => {
      if ((s.roomCanvasEditing[roomId] ?? null) === documentId) return {};
      return { roomCanvasEditing: { ...s.roomCanvasEditing, [roomId]: documentId } };
    }),

  setRoomCanvasLiveRoom: (roomId) =>
    set((s) => (s.roomCanvasLiveRoomId === roomId ? {} : { roomCanvasLiveRoomId: roomId })),
});
