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
 * - **Only into focus that was actually LOST.** The caret is taken only while
 *   nothing holds it — `document.body`, `null`, or an element already detached
 *   from the document. A real, still-connected element is somebody's place, and
 *   this never takes it: not the composer a reader is typing in, not a control
 *   in the panel that is still on its way out. That is a WAIT rather than a
 *   stand-down — the panel's own close button is focused and connected while its
 *   exit animation runs, so giving up on the first sight of it would break the
 *   very case the retry exists for. If the window closes with the caret still
 *   somewhere real, nothing happens at all, which is the stand-down.
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

    const attempt = () => {
      if (cancelled) return;
      // Nothing holds the caret: the body, or an element already detached from
      // the document. Anything else is somebody's place — the reader's own, or
      // a control in the panel that has not finished leaving — and neither is
      // ours to take. Both cases WAIT rather than give up, because the second
      // one resolves by itself a frame or two later.
      const active = document.activeElement;
      const lost = active === null || active === document.body || !active.isConnected;
      if (lost) {
        const row = originRow(rootEntryId);
        if (row !== null) {
          row.focus();
          return;
        }
      }
      if (Date.now() >= deadline) return;
      frame = requestAnimationFrame(attempt);
    };

    // Deferred a frame: React has not committed the removal of the panel at the
    // moment the close is dispatched, so looking now would find the panel still
    // up and the room still gone.
    frame = requestAnimationFrame(attempt);
    cancelRef.current = () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  return { arm };
}
