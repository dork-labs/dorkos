/**
 * Which thread each room's composer is currently writing into, and when that
 * composer should take focus.
 *
 * Keyed by room and held outside the composer for the same two reasons a draft
 * is (`room-drafts.ts`): switching rooms and coming back should find the reply
 * you were part-way through still aimed where you aimed it, and a refused reply
 * has to give both the words AND the aim back even when the composer that sent
 * them has unmounted. Restoring the text into a composer that has silently gone
 * back to addressing the whole room would put the next sentence somewhere the
 * reader did not choose.
 *
 * The focus counter rides along here rather than in a store of its own because
 * it has exactly one cause: an action taken on an entry — replying to it, or
 * mentioning its author — which puts the caret in the composer so the sentence
 * can be typed without reaching for the mouse again. Both are the same request,
 * so they are one number.
 *
 * @module entities/room/model/reply-targets
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/** What each room's composer is aimed at. */
interface ReplyTargetState {
  /** Room id → the entry its composer is replying under, when it is. */
  targets: Record<string, string | undefined>;
  /**
   * Room id → a counter bumped every time something asks for the caret.
   *
   * A counter and not a boolean: two reply presses in a row are two distinct
   * requests, and a flag that is already `true` for the second one is a request
   * the composer never sees. Nothing reads the value — only that it changed.
   */
  focusRequests: Record<string, number>;
}

/** Ways a room's aim changes. */
interface ReplyTargetActions {
  /**
   * Aim a room's composer at one thread and ask for the caret.
   *
   * @param roomId - The room on screen.
   * @param rootEntryId - The entry heading the thread, already resolved by
   *   {@link replyRootFor} — this store does no retargeting of its own.
   */
  replyTo: (roomId: string, rootEntryId: string) => void;
  /**
   * Put a refused reply's aim back — unless the reader has moved on.
   *
   * The mirror of `useRoomDraftStore.restore`, and it exists for the same
   * reason: a refusal lands some time after the send, and the composer is not
   * required to have stood still in between. `restore` merges rather than
   * overwrites because two sentences both have a claim on the box by then; this
   * declines rather than overwrites because only ONE aim can be held, so taking
   * it back would silently point the reader's next sentence at a thread they
   * had already left.
   *
   * Re-aims when the composer is still on the refused thread, or is aimed at
   * nothing — in both cases the words coming back belong where they were going.
   * A composer aimed at a DIFFERENT thread is left alone, focus included: the
   * reader chose that, after this reply was already gone.
   *
   * @param roomId - The room the refused reply was for.
   * @param rootEntryId - The thread it was aimed at when it was sent.
   */
  restoreAim: (roomId: string, rootEntryId: string) => void;
  /** Aim a room's composer back at the room itself. */
  clear: (roomId: string) => void;
  /** Ask for the caret without changing where the composer is aimed. */
  requestFocus: (roomId: string) => void;
}

/** The per-room reply-target store. */
export const useRoomReplyTargetStore = create<ReplyTargetState & ReplyTargetActions>()(
  devtools(
    (set) => ({
      targets: {},
      focusRequests: {},

      replyTo: (roomId, rootEntryId) =>
        set(
          (state) => ({
            targets: { ...state.targets, [roomId]: rootEntryId },
            focusRequests: {
              ...state.focusRequests,
              [roomId]: (state.focusRequests[roomId] ?? 0) + 1,
            },
          }),
          false,
          'roomReplyTargets/replyTo'
        ),

      restoreAim: (roomId, rootEntryId) =>
        set(
          (state) => {
            const current = state.targets[roomId];
            // Returned unchanged rather than as a fresh object, so a decline is
            // not even a notification — nothing re-renders and no caret moves.
            if (current !== undefined && current !== rootEntryId) return state;
            return {
              targets: { ...state.targets, [roomId]: rootEntryId },
              focusRequests: {
                ...state.focusRequests,
                [roomId]: (state.focusRequests[roomId] ?? 0) + 1,
              },
            };
          },
          false,
          'roomReplyTargets/restoreAim'
        ),

      clear: (roomId) =>
        set(
          (state) => ({ targets: { ...state.targets, [roomId]: undefined } }),
          false,
          'roomReplyTargets/clear'
        ),

      requestFocus: (roomId) =>
        set(
          (state) => ({
            focusRequests: {
              ...state.focusRequests,
              [roomId]: (state.focusRequests[roomId] ?? 0) + 1,
            },
          }),
          false,
          'roomReplyTargets/requestFocus'
        ),
    }),
    { name: 'RoomReplyTargetStore' }
  )
);

/**
 * Subscribe to the thread one room's composer is writing into.
 *
 * @param roomId - The room on screen.
 * @returns The root entry id, or `undefined` when the composer addresses the
 *   room itself.
 */
export function useRoomReplyTarget(roomId: string): string | undefined {
  return useRoomReplyTargetStore((state) => state.targets[roomId]);
}

/**
 * Subscribe to a room's caret requests.
 *
 * @param roomId - The room on screen.
 * @returns A number that changes whenever something asks for the composer.
 */
export function useComposerFocusRequest(roomId: string): number {
  return useRoomReplyTargetStore((state) => state.focusRequests[roomId] ?? 0);
}
