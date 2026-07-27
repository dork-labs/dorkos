/**
 * What you have typed in each room but not yet sent.
 *
 * A draft lives here rather than in the composer's own state for two reasons,
 * and the second one is a correctness requirement, not a nicety:
 *
 * - Leaving a room and coming back should find your half-written sentence where
 *   you left it, the way every chat surface behaves.
 * - A refused post has to give the words back even when the composer that sent
 *   them is gone. Both restore paths run outside the component: the reader can
 *   switch rooms before the refusal lands (the composer unmounts), and a second
 *   post detaches the first one's observer (`mutationObserver.js:56-58`), after
 *   which per-call `mutate(…, { onError })` callbacks are never dispatched at
 *   all (`:77`, gated on `hasListeners()`). State that dies with the component
 *   cannot hold a guarantee that outlives it.
 *
 * Keyed by room id, so one conversation's draft can never surface in another.
 *
 * @module entities/room/model/room-drafts
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

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
  /**
   * Put refused words back into the room they were meant for.
   *
   * Anything typed since goes below them rather than being overwritten: at this
   * point two different sentences both have a claim on the box, and choosing
   * one means destroying the other.
   */
  restore: (roomId: string, text: string) => void;
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

      restore: (roomId, text) =>
        set(
          (state) => {
            const current = state.drafts[roomId] ?? '';
            return {
              drafts: { ...state.drafts, [roomId]: current === '' ? text : `${text}\n${current}` },
            };
          },
          false,
          'roomDrafts/restore'
        ),
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
