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
 * 3. **A stream cycle re-proves the table rather than emptying it.** A close is
 *    a DELETION, so a document taken off the table while this reader was
 *    disconnected leaves no trace on the log to replay — nothing but a re-send
 *    of everything still there can correct it, and the server sends exactly that
 *    on every resume (the canvas resync). So a cycle marks every row STALE,
 *    every arriving frame clears its own row's mark, and only when the burst has
 *    ended are rows nobody vouched for swept.
 *
 *    **Emptying the table at cycle start is the thing this replaces, and it was
 *    a data-loss bug.** The resync arrives a round trip later, so the empty
 *    state rendered: the view fell to its splash, the editor unmounted, a
 *    half-typed draft went with it, and the edit lock's cleanup told the server
 *    nobody was typing — all from a two-second network blip, which is an
 *    ordinary event (a tab coming forward, `online` firing, the global stream
 *    recovering). Nothing a person is in the middle of may depend on the network
 *    staying up.
 *
 * What is NOT the server's is which document each of this viewer's two views is
 * showing, and which arrivals they have not looked at yet. Those are per-viewer
 * and live here: a shared table that yanked everybody's tab would be
 * over-participation one layer down (§9.3).
 *
 * @module shared/model/app-store-room-canvas
 */
import type { StateCreator } from 'zustand';
import type { CanvasDocument, RoomCanvasEvent, RoomSignalEvent } from '@dorkos/shared/room-schemas';
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
   * Rows whose resync has not arrived yet, per room — the working set of a
   * cycle, empty between cycles.
   *
   * A row is marked when a subscription cycle begins and unmarked by the frame
   * that names it. Whatever is still marked when the burst ends is what the
   * server no longer has, which is the only way a close missed while
   * disconnected can be learned.
   */
  roomCanvasStale: Readonly<Record<string, readonly string[]>>;
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
   * Who is looking at what, per room — author id to the document they are on.
   *
   * **Live only, and nobody's history.** It is built from `presence` signals,
   * which carry no `seq` and are never replayed, so this holds exactly what has
   * arrived since the stream connected and nothing older. That is the honest
   * shape for the fact: a face left on a document somebody walked away from ten
   * minutes ago is worse than no face.
   *
   * The failure modes fall out of that and are deliberately asymmetric. A reader
   * who joins mid-session sees no faces until people move, which costs nothing.
   * A reader whose browser died leaves a face until the people still looking
   * reconnect — which is what {@link RoomCanvasSlice.roomCanvasPresenceEpoch}
   * bounds.
   */
  roomCanvasPresence: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * How many times each room's stream has cycled — the tick that makes tab
   * presence self-correcting without a heartbeat.
   *
   * A cycle wipes the room's faces, because nothing replays them and every one
   * of them may be stale. The surface that publishes this viewer's own face
   * watches this number, so the wipe is immediately followed by every connected
   * viewer re-stating where they are: one frame per viewer per reconnect, and no
   * traffic at all while nothing is happening.
   */
  roomCanvasPresenceEpoch: Readonly<Record<string, number>>;

  /**
   * A subscription cycle is starting: every row this room holds is now
   * unvouched-for until its resync frame arrives.
   *
   * Marks, never empties (rule 3). What is on screen stays on screen — it was
   * correct a moment ago and is almost certainly correct still — and the sweep
   * at {@link RoomCanvasSlice.endRoomCanvasCycle} is what corrects it. The
   * viewer's own active ids and unread marks are kept too: they are per-viewer
   * facts about attention, and a reconnect is not a reason to forget which tab
   * somebody was on.
   *
   * @param roomId - The room whose stream is (re)connecting.
   */
  beginRoomCanvasCycle: (roomId: string) => void;

  /**
   * The resync burst has ended: drop the rows nobody vouched for.
   *
   * **The document this viewer is EDITING is spared, always.** Their draft is
   * the only copy of what they have typed, and a table that tidied itself by
   * throwing that away would be the bug this whole cycle design exists to
   * prevent. A document genuinely closed under a live edit therefore lingers on
   * this one screen until the edit ends — and the next cycle, which marks it
   * stale again with nothing to vouch for it, is what finally takes it away.
   *
   * @param roomId - The room whose burst has ended.
   */
  endRoomCanvasCycle: (roomId: string) => void;

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
   * Take in one `presence` signal off a room's stream.
   *
   * A frame naming a document says that author is looking at it; one with no
   * document says they are looking at none. Signals that are not `presence` are
   * not this store's business and are dropped.
   *
   * @param roomId - The room the signal arrived on.
   * @param event - The signal.
   */
  applyRoomCanvasPresence: (roomId: string, event: RoomSignalEvent) => void;

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

/**
 * Take one document off a room's stale list — the patch a frame that vouched for
 * a row contributes.
 *
 * Returns an EMPTY patch when there was nothing to clear, so a frame that
 * changes nothing else still returns a no-op rather than churning the store on
 * every heartbeat-shaped event.
 */
function vouchFor(
  stale: Readonly<Record<string, readonly string[]>>,
  roomId: string,
  documentId: string
): { roomCanvasStale?: Record<string, readonly string[]> } {
  const held = stale[roomId];
  if (held === undefined || !held.includes(documentId)) return {};
  return { roomCanvasStale: { ...stale, [roomId]: held.filter((id) => id !== documentId) } };
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
  roomCanvasStale: {},
  roomCanvasLiveRoomId: null,
  roomCanvasPresence: {},
  roomCanvasPresenceEpoch: {},

  beginRoomCanvasCycle: (roomId) =>
    set((s) => ({
      roomCanvasStale: {
        ...s.roomCanvasStale,
        [roomId]: (s.roomCanvasDocuments[roomId] ?? []).map((d) => d.id),
      },
      // **Faces are emptied where documents are only MARKED**, and the
      // difference is which way each one fails. A document that is still on the
      // server's table is re-sent by the resync, so keeping it costs nothing and
      // dropping it would take a half-typed edit with it. A face is re-sent by
      // nothing at all — signals never replay — so keeping one means showing a
      // person on a tab they may have left before the network went away. The
      // epoch below is how the faces come back: every connected viewer re-states
      // where it is looking as soon as its own stream is live again.
      roomCanvasPresence: { ...s.roomCanvasPresence, [roomId]: {} },
      roomCanvasPresenceEpoch: {
        ...s.roomCanvasPresenceEpoch,
        [roomId]: (s.roomCanvasPresenceEpoch[roomId] ?? 0) + 1,
      },
    })),

  endRoomCanvasCycle: (roomId) =>
    set((s) => {
      const stale = s.roomCanvasStale[roomId] ?? [];
      const roomStale = { ...s.roomCanvasStale, [roomId]: [] };
      if (stale.length === 0) return { roomCanvasStale: roomStale };
      // Whatever this viewer is typing in stays, whatever the server says.
      const editing = s.roomCanvasEditing[roomId] ?? null;
      const drop = new Set(stale.filter((id) => id !== editing));
      if (drop.size === 0) return { roomCanvasStale: roomStale };
      const held = s.roomCanvasDocuments[roomId] ?? [];
      const documents = held.filter((d) => !drop.has(d.id));
      return {
        roomCanvasStale: roomStale,
        roomCanvasDocuments: { ...s.roomCanvasDocuments, [roomId]: documents },
        roomCanvasActive: {
          ...s.roomCanvasActive,
          [roomId]: reconcileActive(documents, s.roomCanvasActive[roomId] ?? NO_ACTIVE),
        },
        roomCanvasUnread: {
          ...s.roomCanvasUnread,
          [roomId]: pruneUnread(s.roomCanvasUnread[roomId] ?? NO_UNREAD, documents),
        },
      };
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
      // Somebody vouched for this row, so it is not swept at the end of the
      // cycle — whether they vouched by re-sending it or by closing it.
      const vouched = vouchFor(s.roomCanvasStale, roomId, event.documentId);

      if (event.closed === true || !event.document) {
        // **A close can only ever reach the room whose stream carried it.** It
        // names an id and no room, and the filter below runs over THIS room's
        // own list — so unlike a frame carrying a document, which could write a
        // foreign row in, there is nothing here for a room check to prevent. The
        // ids are scope-derived (`room:<id>` + source key) on top of that, so
        // two rooms cannot even mint the same one.
        if (!held.some((d) => d.id === event.documentId)) return vouched;
        const documents = held.filter((d) => d.id !== event.documentId);
        return {
          ...vouched,
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
      // older one arriving late must not put an older version back on screen —
      // but it has still vouched for the row, so the sweep must not take it.
      if (existing && existing.rev > document.rev) return vouched;

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
      const looking = followIt || active[view] === document.id;

      // **Only something that HAPPENED lights the dot**, which is exactly what
      // `change` reports. A resync frame carries none: it is the server saying
      // "this is still here", and a reconnect that re-lit every dot would put an
      // unread mark back on the tab the reader had just finished reading — once
      // per network blip, forever. `activated` and `pinned` are changes to the
      // ORDER rather than to what a document says, so they light nothing either.
      const arrival = event.change === 'opened' || event.change === 'updated';
      const lights = arrival && !mine && !looking;

      return {
        ...vouched,
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
            lights
              ? withUnread(unread, view, document.id)
              : // A document this viewer is already showing is not unread, and
                // neither is one they just opened themselves.
                looking
                ? withoutUnread(unread, document.id)
                : unread,
            documents
          ),
        },
      };
    }),

  applyRoomCanvasPresence: (roomId, event) =>
    set((s) => {
      if (event.signal !== 'presence') return {};
      const held = s.roomCanvasPresence[roomId] ?? {};
      const documentId = event.documentId;
      if (documentId === undefined) {
        if (held[event.authorId] === undefined) return {};
        const { [event.authorId]: _gone, ...rest } = held;
        return { roomCanvasPresence: { ...s.roomCanvasPresence, [roomId]: rest } };
      }
      if (held[event.authorId] === documentId) return {};
      return {
        roomCanvasPresence: {
          ...s.roomCanvasPresence,
          [roomId]: { ...held, [event.authorId]: documentId },
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
