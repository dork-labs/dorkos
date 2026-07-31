/**
 * When a composer should take the caret.
 *
 * An action taken on a message — replying to it, or mentioning its author —
 * puts the caret in the box you are about to type in, so the sentence can be
 * written without reaching for the mouse again. The action and the box are far
 * apart (a message high up the history, a composer pinned to the bottom, or a
 * thread panel that was not even open a moment ago), so the request travels
 * through here.
 *
 * **Keyed by COMPOSER, not by room.** A room can have two composers on screen
 * at once now — its own, and the open thread panel's — and they must not both
 * answer one request. The key is whatever the composer draws its draft from:
 * the room id for the room's own box, `threadDraftKey(roomId, rootEntryId)` for
 * a panel's. Nothing here parses one; it is an opaque string.
 *
 * This store used to hold a second thing: which thread the room's composer was
 * AIMED at, with a banner above it saying so and a `restoreAim` that put the
 * aim back when a reply was refused. The thread panel retired all of it (design
 * record §3). A thread reply is now written in the panel, which is unmissably
 * the thread — so there is no aim to state, no way for the room's box to
 * silently be pointed somewhere else, and nothing to restore: a refusal gives
 * its words back to the panel's own draft, which is where they were typed.
 *
 * @module entities/room/model/composer-focus
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/** Outstanding caret requests, per composer. */
interface ComposerFocusState {
  /**
   * Composer key → a counter bumped every time something asks for the caret.
   *
   * A counter and not a boolean: two reply presses in a row are two distinct
   * requests, and a flag that is already `true` for the second one is a request
   * the composer never sees. Nothing reads the value — only that it changed.
   */
  focusRequests: Record<string, number>;
}

/** Ways a caret is asked for. */
interface ComposerFocusActions {
  /**
   * Ask a composer for the caret.
   *
   * @param key - The composer's draft key: a room id, or a thread draft key.
   */
  requestFocus: (key: string) => void;
}

/** The composer-focus store. */
export const useComposerFocusStore = create<ComposerFocusState & ComposerFocusActions>()(
  devtools(
    (set) => ({
      focusRequests: {},

      requestFocus: (key) =>
        set(
          (state) => ({
            focusRequests: { ...state.focusRequests, [key]: (state.focusRequests[key] ?? 0) + 1 },
          }),
          false,
          'composerFocus/requestFocus'
        ),
    }),
    { name: 'ComposerFocusStore' }
  )
);

/**
 * Subscribe to one composer's caret requests.
 *
 * @param key - The composer's draft key.
 * @returns A number that changes whenever something asks for this composer.
 */
export function useComposerFocusRequest(key: string): number {
  return useComposerFocusStore((state) => state.focusRequests[key] ?? 0);
}
