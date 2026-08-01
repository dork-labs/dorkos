/**
 * Putting the caret back on the message a closed thread was opened from.
 *
 * @module widgets/room-view/model/use-restore-thread-focus
 */
import { useCallback, useEffect, useRef } from 'react';
import { entryRowId, threadRowId } from '../lib/room-timeline';

/**
 * How long to keep looking for the row before giving up.
 *
 * The room is not necessarily back the instant the panel state flips. On a
 * phone the two are siblings under one `AnimatePresence` in `mode="wait"`, so
 * the panel plays a 150ms exit BEFORE the room mounts at all — a single effect
 * after the close looked the row up, found nothing, and dropped focus on
 * `document.body`. Comfortably past that, and short enough that a reader who
 * has moved on is never yanked back.
 */
const RESTORE_WINDOW_MS = 600;

/** What the caller uses to arm and to run the restore. */
interface RestoreThreadFocus {
  /**
   * Remember the thread being closed, so its origin row can be focused once it
   * is back on screen. Call it as the close is dispatched.
   */
  arm: (rootEntryId: string) => void;
}

/**
 * The row a closed thread should hand focus back to, if it is on screen yet.
 *
 * Two candidates in order: the "↳ N replies" row, which is where a reader who
 * opened the thread by reading it was standing, and then the MESSAGE itself,
 * which is where a reader who opened it from the capsule's "Reply in thread"
 * was — a thread with no replies yet draws no reply row at all, so on that path
 * the first lookup has always pointed at nothing.
 */
function originRow(rootEntryId: string): HTMLElement | null {
  return (
    document.getElementById(threadRowId(rootEntryId)) ??
    document.getElementById(entryRowId(rootEntryId))
  );
}

/**
 * Give the keyboard back the place it was when a thread panel closes.
 *
 * Closing used to drop focus on `document.body`, which for a keyboard reader
 * means losing their place in the room entirely — a regression against the
 * roving-tabindex model the rest of this surface keeps.
 *
 * Three things make it actually land, and each one was a way it failed:
 *
 * - **An id, not a node.** On a phone the thread panel unmounts the room, so any
 *   element captured on the way in is stale by the way out.
 * - **A retry, not one pass.** The room may not be mounted yet when the close
 *   commits — see {@link RESTORE_WINDOW_MS}. It looks again on each animation
 *   frame until the row exists or the window closes.
 * - **Only when focus was actually lost.** If the reader has already put the
 *   caret somewhere themselves — clicked the composer, tabbed into the sidebar —
 *   the restore stands down rather than yanking them back to a message they have
 *   moved on from.
 *
 * @returns The arming function to call as a thread is closed.
 */
export function useRestoreThreadFocus(): RestoreThreadFocus {
  /** Cancels a retry that is still running, so only one is ever in flight. */
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelRef.current?.(), []);

  const arm = useCallback((rootEntryId: string) => {
    cancelRef.current?.();
    let frame = 0;
    const deadline = Date.now() + RESTORE_WINDOW_MS;
    let cancelled = false;
    // Whatever had the caret at the moment of the close — the panel's own close
    // button, or the panel itself when Escape did it. Both are still focused and
    // still in the document for as long as the exit animation runs, so "has the
    // reader moved on?" cannot be asked as "is focus on the body?" alone.
    const closedFrom = document.activeElement;

    const attempt = () => {
      if (cancelled) return;
      // The reader has taken the caret somewhere themselves. Their choice wins
      // over ours — anything still on the way out is not their choice.
      const active = document.activeElement;
      const ours =
        active === null || active === document.body || active === closedFrom || !active.isConnected;
      if (!ours) return;

      const row = originRow(rootEntryId);
      if (row !== null) {
        row.focus();
        return;
      }
      if (Date.now() >= deadline) return;
      frame = requestAnimationFrame(attempt);
    };

    // The first look is deferred a frame on purpose: React has not committed the
    // removal of the panel at the moment the close is dispatched, so looking now
    // would find the panel still up and the room still gone.
    frame = requestAnimationFrame(attempt);
    cancelRef.current = () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  return { arm };
}
