import { useEffect, useRef, useState } from 'react';

/** The window's own state, which a title may reflect. */
export interface DocumentTitleState {
  /** Whether the window is hidden (another browser tab, minimised). */
  hidden: boolean;
  /**
   * Whether a reply finished while the window was hidden. Cleared the moment
   * the window is visible again: you have seen it.
   */
  unseenReply: boolean;
}

/**
 * Keep `document.title` in step with what the window shows.
 *
 * Generic on purpose: this hook owns only what the window itself knows,
 * whether it is hidden and whether a reply finished while it was, and hands
 * that to `format`. What the page is called is the caller's to say (the app
 * shell names it from the active tab's identity), because `shared/` may not
 * know what a chat or a room is. The desktop app mirrors `document.title`, so
 * its native window title follows with no extra wiring.
 *
 * @param format - Build the title from the window's state. Called each render;
 *   the title is written only when the string changes.
 * @param isStreaming - Whether a reply is streaming, so a reply that finishes
 *   while the window is hidden can be flagged.
 */
export function useDocumentTitle(
  format: (state: DocumentTitleState) => string,
  isStreaming: boolean
): void {
  const [hidden, setHidden] = useState(() => document.hidden);
  const [unseenReply, setUnseenReply] = useState(false);

  useEffect(() => {
    const handler = () => {
      setHidden(document.hidden);
      // Back on screen: whatever finished has now been seen.
      if (!document.hidden) setUnseenReply(false);
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // A streaming → idle edge while hidden is a reply nobody has seen yet.
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming && document.hidden) setUnseenReply(true);
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  const title = format({ hidden, unseenReply });
  useEffect(() => {
    document.title = title;
  }, [title]);
}
