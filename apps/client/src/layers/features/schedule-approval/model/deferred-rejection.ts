/**
 * Rejecting a proposed schedule, undoably — by not sending it yet.
 *
 * ## Why the delete is deferred rather than undone
 *
 * Rejecting a schedule DELETES it, and a delete has no server-side undo: the
 * row and its file are gone, and "put it back" would mean re-creating a task
 * with a new id, a new file and no provenance. So the undo lives on this side
 * of the wire — the card says "Rejected · Undo" straight away and the DELETE is
 * simply not sent until the window closes. Undo cancels a request that was
 * never made, which is the only kind of undo that is always honest.
 *
 * ## Why the timer is a module and not a `useEffect`
 *
 * The card is drawn inside a popover. Rejecting a schedule and immediately
 * closing the panel — or pressing Escape, or having the last card decided out
 * from under it — unmounts the component, and a timer owned by that component
 * would die with it: the schedule would sit there rejected-looking until the
 * next refetch put it back, and nothing would ever have been deleted. Parking
 * the timer here means the window belongs to the DECISION, not to whichever
 * copy of the card happened to be on screen when it was made. A card that
 * remounts mid-window (reopening the panel) reads {@link isRejectionPending}
 * and comes back showing its receipt and a live Undo.
 *
 * The same reasoning covers the tab going away: `pagehide` flushes every
 * pending rejection, because a person who rejected something and closed the
 * window meant it. That flush is best effort rather than a guarantee — see
 * {@link flushRejections}. The listener is bound only while something is
 * actually waiting, so an idle cockpit carries no global handler.
 *
 * @module features/schedule-approval/model/deferred-rejection
 */
import { useSyncExternalStore } from 'react';

/**
 * How long a rejected schedule stays undoable, in milliseconds.
 *
 * Long enough to read the receipt and change your mind, short enough that
 * nobody wonders whether the click worked. The card holds its receipt for the
 * whole window, so this is also how long the row stays on screen after a
 * rejection.
 */
export const REJECTION_UNDO_MS = 5_000;

/** One rejection waiting for its window to close. */
interface ScheduledRejection {
  /** The timer that will send it. */
  timer: ReturnType<typeof setTimeout>;
  /** What to actually do when the window closes — the DELETE itself. */
  commit: () => void;
}

/** Every rejection currently inside its undo window, keyed by task id. */
const pending = new Map<string, ScheduledRejection>();

/** Everyone who wants to know when that map changes. */
const listeners = new Set<() => void>();

/** Whether the `pagehide` flush is currently bound. */
let unloadBound = false;

/** Tell every subscriber the pending set changed. */
function notify(): void {
  // Copied first: a listener is free to unsubscribe as it runs, and mutating
  // the set mid-iteration would skip whoever came next.
  for (const listener of [...listeners]) listener();
}

/** Bind the unload flush, once, while anything is waiting. */
function bindUnload(): void {
  if (unloadBound || typeof window === 'undefined') return;
  // `pagehide` rather than `beforeunload`: it fires for the back/forward cache
  // and on mobile app switches, which `beforeunload` does not, and it does not
  // ask the browser to prompt anybody about leaving.
  window.addEventListener('pagehide', flushRejections);
  unloadBound = true;
}

/** Drop the unload flush the moment nothing is waiting on it. */
function unbindUnload(): void {
  if (!unloadBound || typeof window === 'undefined') return;
  window.removeEventListener('pagehide', flushRejections);
  unloadBound = false;
}

/**
 * Reject a schedule in {@link REJECTION_UNDO_MS}, unless somebody says otherwise.
 *
 * Re-scheduling the same task restarts its window — deciding a card twice is
 * one decision, not two deletes.
 *
 * @param taskId - The schedule being rejected.
 * @param commit - What to run when the window closes. This is the DELETE, and
 *   it must not assume the card that scheduled it is still mounted.
 */
export function rejectAfterUndoWindow(taskId: string, commit: () => void): void {
  const existing = pending.get(taskId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(taskId);
    if (pending.size === 0) unbindUnload();
    commit();
    notify();
  }, REJECTION_UNDO_MS);

  pending.set(taskId, { timer, commit });
  bindUnload();
  notify();
}

/**
 * Take it back. The DELETE was never sent, so there is nothing to reverse.
 *
 * @param taskId - The schedule to un-reject.
 * @returns True when there was a rejection to cancel — false means the window
 *   had already closed and the delete is on its way.
 */
export function cancelRejection(taskId: string): boolean {
  const entry = pending.get(taskId);
  if (entry === undefined) return false;
  clearTimeout(entry.timer);
  pending.delete(taskId);
  if (pending.size === 0) unbindUnload();
  notify();
  return true;
}

/**
 * Send every pending rejection now.
 *
 * Bound to `pagehide`: somebody who rejected a schedule and closed the tab made
 * a decision, and dropping it on the floor would leave the proposal sitting in
 * their Inbox next time they opened the cockpit.
 *
 * **Best effort, and deliberately not claimed as more.** The DELETE goes out
 * through the ordinary transport, which uses a plain `fetch` — no `keepalive`,
 * no `sendBeacon` — so a browser tearing the page down is free to cancel the
 * request in flight. It converts "certainly lost" into "usually sent", which is
 * worth having; it is not a durability guarantee, and no user-facing copy
 * promises one. Making it a guarantee would mean a keepalive path through the
 * transport, which nothing in this repo has yet.
 */
export function flushRejections(): void {
  if (pending.size === 0) return;
  const entries = [...pending.values()];
  pending.clear();
  unbindUnload();
  for (const entry of entries) {
    clearTimeout(entry.timer);
    entry.commit();
  }
  notify();
}

/**
 * Whether this schedule is inside its undo window right now.
 *
 * @param taskId - The schedule to ask about.
 */
export function isRejectionPending(taskId: string): boolean {
  return pending.has(taskId);
}

/**
 * Watch the pending set.
 *
 * @param listener - Called after every change.
 * @returns The unsubscribe.
 */
export function subscribeToRejections(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether this schedule is inside its undo window, as React state.
 *
 * This is what lets a remounted card pick a decision back up: the window
 * belongs to the module, so a card that was unmounted and drawn again reads the
 * same answer the one before it was showing.
 *
 * @param taskId - The schedule to watch.
 */
export function useRejectionPending(taskId: string): boolean {
  return useSyncExternalStore(
    subscribeToRejections,
    () => isRejectionPending(taskId),
    // The server render has no timers and no decisions in flight.
    () => false
  );
}

/**
 * Drop every pending rejection WITHOUT sending it.
 *
 * Test-only teardown. Nothing in the app calls this: discarding a decision
 * somebody made is exactly what {@link flushRejections} exists to prevent.
 */
export function discardPendingRejections(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  unbindUnload();
  notify();
}
