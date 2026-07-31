/**
 * Which thread each room currently has open in its panel.
 *
 * Keyed by room, and held here rather than in the page, for the same reason a
 * draft is (`room-drafts.ts`): the thing that OPENS a thread is an action on a
 * message — a reply row in the timeline, or "Reply in thread" in the entry
 * capsule — and those live far from the page that draws the panel. A store is
 * what lets a message open a panel without either of them knowing about the
 * other.
 *
 * **This store is the source of truth for what is drawn; the URL is a mirror.**
 * `ChannelsPage` writes `?thread=` from it and seeds it back on the way in
 * (`use-thread-url-sync.ts`), which is what makes a refresh or a shared link
 * land on the open thread. Doing it the other way round — the router as the
 * source — would put `useNavigate` inside `useEntryActions`, which is rendered
 * by the Dev Playground under a different route entirely.
 *
 * This replaced a per-room "reply target": the thread the ROOM's composer had
 * been silently aimed at, with a banner above it as the only sign. The panel
 * removed the need for it — a thread reply is typed in the thread — so what is
 * stored now is what is on SCREEN rather than where a box is pointed. Opening a
 * thread you are not writing in is the ordinary case: you clicked a reply row
 * to read it.
 *
 * @module entities/room/model/open-thread
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/** An open thread, and how it was opened. */
export interface OpenThread {
  /** The entry heading the thread the panel is showing. */
  rootEntryId: string;
  /**
   * True when the reader asked to WRITE, not just to read.
   *
   * "Reply in thread" in the entry capsule is a request to type, so the panel
   * hands its composer the caret. Clicking a reply row is a request to read, so
   * the panel takes focus itself and leaves the keyboard alone — which on a
   * phone is the difference between opening a thread and opening a keyboard
   * over it.
   *
   * It has to live HERE rather than in the focus store because the composer it
   * addresses does not exist yet when the request is made: the same press that
   * asks for the caret is the press that mounts the box.
   */
  focusComposer: boolean;
}

/** What each room has open beside it. */
interface OpenThreadState {
  /** Room id → the thread its panel is showing. */
  open: Record<string, OpenThread | undefined>;
}

/** Ways the open thread changes. */
interface OpenThreadActions {
  /**
   * Open one thread's panel, replacing whatever the room had open.
   *
   * Clicking another thread's reply row SWITCHES rather than stacking, which is
   * the whole reason this is one value per room and not a set.
   *
   * @param roomId - The room on screen.
   * @param rootEntryId - The entry heading the thread, already resolved by
   *   `replyRootFor` — this store does no retargeting of its own.
   * @param focusComposer - True when the reader asked to write. See
   *   {@link OpenThread.focusComposer}.
   */
  openThread: (roomId: string, rootEntryId: string, focusComposer?: boolean) => void;
  /** Close a room's panel. */
  closeThread: (roomId: string) => void;
}

/** The per-room open-thread store. */
export const useRoomOpenThreadStore = create<OpenThreadState & OpenThreadActions>()(
  devtools(
    (set) => ({
      open: {},

      openThread: (roomId, rootEntryId, focusComposer = false) =>
        set(
          (state) => {
            const held = state.open[roomId];
            // Returned unchanged when the same thread is already open the same
            // way, so clicking the row of the thread you are reading is not a
            // re-render, a URL write, or a caret that jumps.
            if (held?.rootEntryId === rootEntryId && held.focusComposer === focusComposer) {
              return state;
            }
            return { open: { ...state.open, [roomId]: { rootEntryId, focusComposer } } };
          },
          false,
          'roomOpenThread/openThread'
        ),

      closeThread: (roomId) =>
        set(
          (state) =>
            state.open[roomId] === undefined
              ? state
              : { open: { ...state.open, [roomId]: undefined } },
          false,
          'roomOpenThread/closeThread'
        ),
    }),
    { name: 'RoomOpenThreadStore' }
  )
);

/**
 * Subscribe to the thread one room has open.
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @returns The open thread, or `undefined` when no panel is open.
 */
export function useRoomOpenThread(roomId: string | null): OpenThread | undefined {
  return useRoomOpenThreadStore((state) => (roomId === null ? undefined : state.open[roomId]));
}
