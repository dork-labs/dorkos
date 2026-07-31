/**
 * What you have typed in each room but not yet sent.
 *
 * A draft lives here rather than in the composer's own state so that leaving a
 * room and coming back finds your half-written sentence where you left it, the
 * way every chat surface behaves.
 *
 * It used to hold a second job — giving a refused post's words back — and that
 * is gone (DOR-783). A refusal now keeps its words in the pending row that has
 * been holding them since the keystroke (`pending-posts`), which is both a
 * better place for them and the only one that can say WHICH of two in-flight
 * messages failed. Merging a refusal into this box meant two sentences with a
 * claim on one field, and a reader who then pressed Enter sent both as one.
 *
 * Keyed by room id, so one conversation's draft can never surface in another —
 * and by {@link threadDraftKey} for a thread panel's composer, which is a
 * second box on screen at the same time as the room's own and must not share
 * its text. Every method takes that key opaquely; nothing here parses one.
 *
 * @module entities/room/model/room-drafts
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * The draft key for a thread panel's composer.
 *
 * A room can have its own composer and a thread panel's on screen together, so
 * "the draft" is no longer one string per room. The panel gets a key of its
 * own, per thread: typing in a thread does not disturb the sentence waiting in
 * the room, and closing the panel and reopening it finds what you were writing
 * — the same promise the room's own draft already makes.
 *
 * `#` cannot appear in an entry id (they are uuids), so no room id can ever
 * collide with a thread key.
 *
 * @param roomId - The room holding the thread.
 * @param rootEntryId - The entry heading the open thread.
 */
export function threadDraftKey(roomId: string, rootEntryId: string): string {
  return `${roomId}#${rootEntryId}`;
}

/** Unsent text, per room. */
interface RoomDraftState {
  /** Room id → the text sitting in that room's composer. */
  drafts: Record<string, string>;
}

/** Ways a draft changes. */
interface RoomDraftActions {
  /** Record what is currently typed in a room. */
  set: (roomId: string, text: string) => void;
  /**
   * Read a room's draft and clear it in one step.
   *
   * Atomic on purpose: this is the sole guard against one keystroke sending
   * twice. Two Enters arriving before React re-renders both read the same stale
   * render closure, so the composer reads the draft from HERE at submit time —
   * the second read sees the empty string the first one left and does nothing.
   * A latch comparing message bodies did the same job but could not tell a
   * duplicate from someone deliberately sending "ok" twice in a row.
   */
  take: (roomId: string) => string;
}

/** The per-room draft store. */
export const useRoomDraftStore = create<RoomDraftState & RoomDraftActions>()(
  devtools(
    (set, get) => ({
      drafts: {},

      set: (roomId, text) =>
        set((state) => ({ drafts: { ...state.drafts, [roomId]: text } }), false, 'roomDrafts/set'),

      take: (roomId) => {
        const held = get().drafts[roomId] ?? '';
        if (held !== '') {
          set((state) => ({ drafts: { ...state.drafts, [roomId]: '' } }), false, 'roomDrafts/take');
        }
        return held;
      },
    }),
    { name: 'RoomDraftStore' }
  )
);

/**
 * Subscribe to one room's draft.
 *
 * @param roomId - The room whose composer is on screen.
 * @returns The text to render in it, `''` when nothing is held.
 */
export function useRoomDraft(roomId: string): string {
  return useRoomDraftStore((state) => state.drafts[roomId] ?? '');
}
