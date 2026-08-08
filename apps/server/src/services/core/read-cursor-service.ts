/**
 * Read state as the rest of DorkOS sees it: one write, and everybody who is
 * looking finds out (team-room-home spec §D4, ADR 260808-140956).
 *
 * {@link ReadCursorStore} owns the table and the monotonic guard; this owns the
 * one thing a store must not, which is telling the world. The split is the same
 * one `RoomStore`/`RoomService` already draws, and for the same reason: a store
 * that broadcast would make every migration and every backfill announce itself
 * to every connected screen.
 *
 * @module server/services/core/read-cursor-service
 */
import type { ReadCursorThreadKind } from '@dorkos/shared/read-cursor-schemas';
import { eventFanOut } from './event-fan-out.js';
import type { ReadCursor, ReadCursorStore } from './read-cursor-store.js';

/** What a `read_cursor` broadcast says: whose cursor moved, in what, and to where. */
export interface ReadCursorMoved {
  /** The person whose cursor moved. A reader ignores anyone else's. */
  userId: string;
  /** Which store `threadId` addresses. */
  threadKind: ReadCursorThreadKind;
  /** The thread. */
  threadId: string;
  /** Where the cursor now stands. */
  lastReadSeq: number;
}

/** Move read cursors, and announce the ones that actually moved. */
export class ReadCursorService {
  /**
   * Binds the service to a cursor store.
   *
   * @param store - The read-cursor table.
   */
  constructor(private readonly store: ReadCursorStore) {}

  /**
   * Move this person's cursor forward and tell their other screens.
   *
   * **A write that changes nothing announces nothing.** Re-opening a thread
   * already read is the ordinary case, so a broadcast per call would make this
   * the loudest event on the global stream and would repaint a badge that never
   * changed. The comparison is made against the value read before the write
   * rather than by re-deriving the monotonic rule here — the rule lives in the
   * store's `WHERE` clause, and stating it twice is how the two stop agreeing.
   *
   * @param userId - The person; always the caller, never named in a request body.
   * @param threadKind - Which kind of thread.
   * @param threadId - The thread.
   * @param lastReadSeq - The position they have now read to.
   * @returns The cursor as it now stands — the higher of the stored value and
   *   the requested one, so a refused write answers with what still holds.
   */
  advance(
    userId: string,
    threadKind: ReadCursorThreadKind,
    threadId: string,
    lastReadSeq: number
  ): ReadCursor {
    const before = this.store.get(userId, threadKind, threadId)?.lastReadSeq ?? null;
    const cursor = this.store.set(userId, threadKind, threadId, lastReadSeq);
    if (cursor.lastReadSeq === before) return cursor;

    const moved: ReadCursorMoved = {
      userId,
      threadKind,
      threadId,
      lastReadSeq: cursor.lastReadSeq,
    };
    eventFanOut.broadcast('read_cursor', moved);
    return cursor;
  }
}

let active: ReadCursorService | null = null;

/**
 * Register the active service at bootstrap, beside the other subsystem
 * singletons.
 *
 * @param service - The wired service.
 */
export function setReadCursorService(service: ReadCursorService): void {
  active = service;
}

/** Read the active service (throws if bootstrap has not run). */
export function getReadCursorService(): ReadCursorService {
  if (!active) throw new Error('ReadCursorService not initialized');
  return active;
}
