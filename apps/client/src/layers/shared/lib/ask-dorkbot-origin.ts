/**
 * Where the operator was standing when they pressed Ask DorkBot.
 *
 * The footer strip and the chat model live in two different features and are
 * separated in time by a navigation, so the one fact the chat model cannot
 * recover for itself is the page the person came FROM — by the time the seed is
 * built, the address bar says `/session`. The button records it here on the way
 * out; the seed builder takes it on the way in (BC-48).
 *
 * A module-level latch rather than a store, and so it lives in `shared/lib`
 * rather than `shared/model`: nothing renders from it, no component subscribes
 * to it, and a re-render must not be able to reset it — the same shape and the
 * same reasoning as `use-launch-prompt`'s own latches. It is TAKEN rather than
 * read, so a stale origin can never attach itself to a second, unrelated seed
 * later in the session.
 *
 * @module shared/lib/ask-dorkbot-origin
 */

/** The pathname recorded by the last Ask DorkBot press, until something takes it. */
let pendingOrigin: string | null = null;

/**
 * Record the page Ask DorkBot was pressed on.
 *
 * @param pathname - The route the operator was on, e.g. `/marketplace`.
 */
export function setAskDorkBotOrigin(pathname: string): void {
  pendingOrigin = pathname;
}

/**
 * Take the recorded origin, clearing it.
 *
 * @returns The pathname the last press recorded, or `null` when there is none —
 *   which is the honest answer after a reload, and the seed omits the line
 *   rather than guessing a page.
 */
export function takeAskDorkBotOrigin(): string | null {
  const origin = pendingOrigin;
  pendingOrigin = null;
  return origin;
}
