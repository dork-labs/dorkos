/**
 * Read state for the embed — the same cursor contract, kept in this browser.
 *
 * `DirectTransport` runs with no DorkOS server behind it (Obsidian, in-process),
 * so the `read_cursors` table is simply not there. The Transport seam is exactly
 * where that choice belongs: the unread rule asks for a position and stores one,
 * and it neither knows nor cares whether the answer came from SQLite or from
 * `localStorage`. Refusing here instead would leave the embed with a rule that
 * never draws and never clears, which reads as a broken divider rather than as a
 * missing server.
 *
 * **What the embed gives up is sharing, not the feature.** A vault's marks stay
 * in the browser profile that made them — which is what the cockpit's own
 * watermark did before this moved server-side — so a mark made in Obsidian does
 * not clear the same conversation in the web cockpit.
 *
 * @module shared/lib/direct/read-cursor-methods
 */
import type { ReadCursor, ReadCursorThreadKind } from '@dorkos/shared/read-cursor-schemas';

/** Key prefix for locally-held cursors. Kind-scoped, so ids cannot collide across kinds. */
const LOCAL_CURSOR_PREFIX = 'dorkos:read-cursor:';

/**
 * Who a locally-held cursor belongs to.
 *
 * There is one reader per vault and no account to name them, so the field is
 * filled with the same sentinel the server uses for an unbound local human. It
 * exists to satisfy the contract, and nothing in the embed reads it back.
 */
const LOCAL_USER_ID = 'local';

/** Storage key for one thread's cursor. */
function cursorKey(threadKind: ReadCursorThreadKind, threadId: string): string {
  return `${LOCAL_CURSOR_PREFIX}${threadKind}:${threadId}`;
}

/** The stored position, or null when there is none (or storage is unreadable). */
function readStoredSeq(threadKind: ReadCursorThreadKind, threadId: string): number | null {
  try {
    const raw = window.localStorage.getItem(cursorKey(threadKind, threadId));
    if (raw === null) return null;
    const seq = Number.parseInt(raw, 10);
    return Number.isInteger(seq) && seq >= 0 ? seq : null;
  } catch {
    // Storage can throw outright (a host that disables it). An unread rule is a
    // nicety and never a reason to fail a read.
    return null;
  }
}

/**
 * Create the local read-state methods for `DirectTransport`.
 *
 * Monotonic like the server's: a position at or below the stored one is ignored
 * and the stored value is answered back, so the rule cannot be dragged backwards
 * by a stale caller here either.
 */
export function createLocalReadCursorMethods() {
  return {
    async getReadCursor(
      threadKind: ReadCursorThreadKind,
      threadId: string
    ): Promise<ReadCursor | null> {
      const lastReadSeq = readStoredSeq(threadKind, threadId);
      if (lastReadSeq === null) return null;
      return {
        userId: LOCAL_USER_ID,
        threadKind,
        threadId,
        lastReadSeq,
        updatedAt: new Date().toISOString(),
      };
    },

    async setReadCursor(
      threadKind: ReadCursorThreadKind,
      threadId: string,
      lastReadSeq: number
    ): Promise<ReadCursor> {
      const stored = readStoredSeq(threadKind, threadId) ?? -1;
      const next = Math.max(stored, lastReadSeq);
      try {
        window.localStorage.setItem(cursorKey(threadKind, threadId), String(next));
      } catch {
        // Best-effort, and deliberately not an error: the caller stops writing
        // for good on a rejection, and a browser that cannot store a cursor
        // should still get a rule that behaves for as long as the view is open.
      }
      return {
        userId: LOCAL_USER_ID,
        threadKind,
        threadId,
        lastReadSeq: next,
        updatedAt: new Date().toISOString(),
      };
    },
  };
}
