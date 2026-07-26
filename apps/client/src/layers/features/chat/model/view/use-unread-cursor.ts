/**
 * Per-session "where I left off" cursor for the message list's unread rule.
 *
 * @module features/chat/model/view/use-unread-cursor
 */
import { useCallback, useState } from 'react';

/**
 * localStorage key prefix for the cursor. Client-local by decision (spec
 * `multi-participant-message-list`, D4): for a single-operator cockpit "new
 * messages" is about THIS browser's last view, so a server round-trip buys
 * nothing. It moves server-side when accounts land.
 */
const CURSOR_STORAGE_PREFIX = 'dorkos:chat:last-seen:';

/** Storage key for one session's cursor. */
function cursorKey(sessionId: string): string {
  return `${CURSOR_STORAGE_PREFIX}${sessionId}`;
}

/**
 * Read a session's stored cursor, or null when there is none.
 *
 * Storage can throw outright (Safari private mode, a host that disables it), and
 * an unread rule is a nicety — never a reason to fail a render.
 */
function readCursor(sessionId: string): string | null {
  try {
    return window.localStorage.getItem(cursorKey(sessionId));
  } catch {
    return null;
  }
}

/** Persist a session's cursor, silently doing nothing when storage is unavailable. */
function writeCursor(sessionId: string, messageId: string): void {
  try {
    window.localStorage.setItem(cursorKey(sessionId), messageId);
  } catch {
    // See readCursor — storage is best-effort.
  }
}

/** What {@link useUnreadCursor} hands back to the list. */
export interface UnreadCursor {
  /**
   * Newest message the reader had already seen when this view opened, or null
   * when the session has no stored cursor (then no rule renders).
   *
   * Frozen for the lifetime of the view: it deliberately does NOT chase
   * messages that arrive while the reader is here, so the rule stays put under
   * them the way Slack's does.
   */
  lastSeenMessageId: string | null;
  /** Record the newest message as seen. Call while the list is pinned to the bottom. */
  markSeen: () => void;
}

/**
 * Track where the reader left off in a session.
 *
 * Reads the stored cursor once per session and returns it unchanged while the
 * view is open. Writing is entirely the caller's call:
 * {@link UnreadCursor.markSeen} while the list is pinned to the bottom.
 *
 * There is deliberately NO write on unmount or session change. `markSeen`
 * re-identifies whenever the newest message changes, so a reader watching a live
 * conversation has already recorded every message that landed — the watching
 * case is covered. A leave-write would only ever consume an unread rule the
 * reader never actually looked at.
 *
 * That protection is only half the job, and the other half is the caller's:
 * whatever decides "pinned to the bottom" must not answer yes before the list
 * has real scroll geometry. `MessageList` gates its `markSeen` call on a
 * measured commit for exactly this reason — see the `measured` flag there. Open
 * a session with unread messages, scroll nowhere, and the cursor must still
 * hold the id it held when the view opened.
 *
 * @param sessionId - Session whose cursor to track.
 * @param newestMessageId - Id of the newest message currently in the transcript.
 */
export function useUnreadCursor(
  sessionId: string,
  newestMessageId: string | undefined
): UnreadCursor {
  // Read once per session and hold it. Re-reading on any render would let a
  // write made while pinned move the rule out from under the reader; re-reading
  // in an effect would render one frame with the previous session's cursor. This
  // is React's documented "adjust state when a prop changes" pattern.
  const [cursor, setCursor] = useState(() => ({
    sessionId,
    lastSeenMessageId: readCursor(sessionId),
  }));
  if (cursor.sessionId !== sessionId) {
    setCursor({ sessionId, lastSeenMessageId: readCursor(sessionId) });
  }

  const markSeen = useCallback(() => {
    if (newestMessageId) writeCursor(sessionId, newestMessageId);
  }, [sessionId, newestMessageId]);

  return { lastSeenMessageId: cursor.lastSeenMessageId, markSeen };
}
