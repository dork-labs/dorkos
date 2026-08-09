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
 * **This is the write path every REQUEST takes.** A route, a room, a session —
 * anything answering a person — comes through here, because a cursor moved
 * without the broadcast is a badge that stays lit on the reader's other screen,
 * and that is the whole point of the phase. Reaching for
 * {@link ReadCursorStore.set} instead compiles and passes its own tests; only a
 * second device notices. Migrations and backfills are the exception, and they
 * do not run through TypeScript at all.
 *
 * @module server/services/core/read-cursor-service
 */
import type { ReadCursor, ReadCursorThreadKind } from '@dorkos/shared/read-cursor-schemas';
import { eventFanOut } from './event-fan-out.js';
import type { ReadCursorStore } from './read-cursor-store.js';

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
  /**
   * What this thread's unread badge should now read, when the caller can say.
   *
   * **It rides the event because the reader cannot work it out.** A room summary
   * in a sidebar carries no `seq` to measure a new cursor against, so a second
   * device holding only `lastReadSeq` could guess zero — and zero is wrong the
   * moment something arrived after the other device stopped reading.
   *
   * Absent when the caller has no cheap count to give, which is not the same as
   * zero: a reader that finds no count leaves the badge it already has alone
   * rather than clearing it.
   */
  unreadCount?: number;
}

/** What a caller may add to the broadcast a moved cursor makes. */
export interface ReadCursorAdvanceOptions {
  /**
   * The unread count to carry, computed only if the cursor actually moved.
   *
   * A function rather than a number because re-opening a thread already read is
   * the ordinary call: the count is a `COUNT(*)` over a log, and paying for it
   * on every no-op would make the cheapest thing a client does the most
   * expensive. It is handed the cursor as it now STANDS, which is not
   * necessarily the one that was requested.
   */
  unreadCount?: (lastReadSeq: number) => number;
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
   * Where this person has read up to, or `null` when they have never read this
   * thread.
   *
   * A pass-through, and deliberately so: a caller that needs to READ cursors
   * should not have to hold a second reference to the store just because the
   * one thing this class adds is on the write path. The read methods here are
   * the store's, unchanged.
   *
   * @param userId - The person.
   * @param threadKind - Which kind of thread.
   * @param threadId - The thread.
   */
  get(userId: string, threadKind: ReadCursorThreadKind, threadId: string): ReadCursor | null {
    return this.store.get(userId, threadKind, threadId);
  }

  /**
   * Every thread of one kind this person has read, keyed by thread id — one
   * query for a whole sidebar. See {@link ReadCursorService.get} on why the
   * reads live here too.
   *
   * @param userId - The person.
   * @param threadKind - Which kind of thread.
   */
  listForUser(userId: string, threadKind: ReadCursorThreadKind): Map<string, number> {
    return this.store.listForUser(userId, threadKind);
  }

  /**
   * Everybody who has read one thread, keyed by person — one query for a whole
   * roster.
   *
   * @param threadKind - Which kind of thread.
   * @param threadId - The thread.
   */
  listForThread(threadKind: ReadCursorThreadKind, threadId: string): Map<string, number> {
    return this.store.listForThread(threadKind, threadId);
  }

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
   * @param opts.unreadCount - What the badge should now read, computed only if
   *   the cursor moved. See {@link ReadCursorAdvanceOptions.unreadCount}.
   * @returns The cursor as it now stands — the higher of the stored value and
   *   the requested one, so a refused write answers with what still holds.
   */
  advance(
    userId: string,
    threadKind: ReadCursorThreadKind,
    threadId: string,
    lastReadSeq: number,
    opts: ReadCursorAdvanceOptions = {}
  ): ReadCursor {
    // `?? 0`, not `?? null`: "never read this thread" and "read up to position
    // 0" are the same fact to the question being asked here, which is only ever
    // "did this cursor MOVE". Reading `null` for absence would make the first
    // write of 0 — the shape a client sends when it opens an empty thread —
    // announce a move that did not happen, and every screen the person has open
    // would repaint a badge that was already clear.
    const before = this.store.get(userId, threadKind, threadId)?.lastReadSeq ?? 0;
    const cursor = this.store.set(userId, threadKind, threadId, lastReadSeq);
    if (cursor.lastReadSeq === before) return cursor;

    const moved: ReadCursorMoved = {
      userId,
      threadKind,
      threadId,
      lastReadSeq: cursor.lastReadSeq,
      ...(opts.unreadCount ? { unreadCount: opts.unreadCount(cursor.lastReadSeq) } : {}),
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
