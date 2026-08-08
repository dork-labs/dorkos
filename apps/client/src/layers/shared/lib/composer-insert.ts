/**
 * Composer-insert bridge — a module singleton that lets any surface drop text
 * into the chat composer and focus it, without importing the chat.
 *
 * The file explorer's "Add to Chat" is the first caller: it is a feature, the
 * composer is a feature, and features may not reach into each other's models.
 * The chat's input container registers its insert handler here on mount;
 * callers invoke {@link requestComposerInsert}. Deliberately NOT part of the
 * agent-facing `UiCommand` schema — this is a client-internal seam between two
 * pieces of the cockpit, not something an agent asks for.
 *
 * Same singleton-in-shared pattern as `extension-remount`. One handler at a
 * time, last registration wins: only one composer is ever on screen.
 *
 * @module shared/lib/composer-insert
 */

/** The currently-registered insert handler, or null when no composer is mounted. */
let insertHandler: ((text: string) => void) | null = null;

/**
 * Register the composer's insert handler. Called by the chat input container on
 * mount; returns an unregister function to call on unmount so a torn-down
 * composer never leaves a stale handler behind.
 *
 * @param handler - Appends `text` to the composer's current value and focuses it.
 * @returns An unregister function (idempotent; only clears its own handler).
 */
export function registerComposerInsert(handler: (text: string) => void): () => void {
  insertHandler = handler;
  return () => {
    if (insertHandler === handler) insertHandler = null;
  };
}

/**
 * Ask the composer to insert `text` and take focus.
 *
 * @param text - The text to insert, ready to use (callers own their own spacing).
 * @returns `false` when no composer is mounted, so the caller can say so.
 */
export function requestComposerInsert(text: string): boolean {
  if (!insertHandler) return false;
  insertHandler(text);
  return true;
}
