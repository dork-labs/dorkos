/**
 * Open a closed group when something inside it has to be seen.
 *
 * @module features/chat-list/model/use-reveal
 */
import { useState } from 'react';

/**
 * Open/closed state for a fold the person controls, which opens itself each
 * time `revealKey` changes to a new non-null value: the open chat landing in
 * it, or a search matching something in it. It never closes itself, so a fold
 * the person opened stays open, and one they close stays closed until the next
 * reason to reveal it.
 *
 * @param revealKey - Why the fold must show its contents now, or null for no
 *   reason. A new string is a new reason.
 * @param initiallyOpen - Whether the fold starts open.
 */
export function useReveal(
  revealKey: string | null,
  initiallyOpen = false
): [boolean, (next: (previous: boolean) => boolean) => void] {
  const [open, setOpen] = useState(initiallyOpen || revealKey !== null);
  // Adjusted while rendering, React's pattern for state that follows a prop:
  // an effect would paint the closed fold for a frame first.
  const [seenKey, setSeenKey] = useState(revealKey);
  if (revealKey !== seenKey) {
    setSeenKey(revealKey);
    if (revealKey !== null) setOpen(true);
  }
  return [open, setOpen];
}

/**
 * The reveal key for a fold holding `ids`: the open chat when it is inside,
 * else the search text when a search is on (everything a search shows
 * matched it), else null.
 *
 * @param ids - The chats inside the fold.
 * @param activeSessionId - The chat open on the chat page.
 * @param search - The current search text.
 */
export function revealKeyFor(
  ids: readonly string[],
  activeSessionId: string | null,
  search: string
): string | null {
  if (activeSessionId !== null && ids.includes(activeSessionId)) return `open:${activeSessionId}`;
  const needle = search.trim();
  return needle === '' ? null : `search:${needle}`;
}
