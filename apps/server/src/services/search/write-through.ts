/**
 * Indexing a room entry the moment it is written, instead of up to five minutes
 * later (message-search spec §5, Amendment 6).
 *
 * The reconciler is the general answer, and it has to be: for a transcript on
 * disk there is nothing to hook, so the only way to know something was said is
 * to look. **The room log is the one source where DorkOS owns the write**, so it
 * knows the instant a room has gained something — and a person who has just
 * asked a question and cannot find it is not reassured that a sweep is coming.
 *
 * ## The contract, and it is the whole reason this is a module rather than a line
 *
 * **The room log is the truth; the index is a copy.** So an index write that
 * fails must never fail the post that produced it. This function therefore
 * catches everything, logs once, and returns — and the failure is not lost, it
 * is DEFERRED: the reconciler's next pass reads the same frontier row, finds the
 * container's watermark below its `max(seq)`, and indexes the entries that were
 * missed. That is not a fallback added on top; it is the sweep doing exactly
 * what it does for a room nobody has posted in for four minutes.
 *
 * **It is synchronous, deliberately.** Three reasons, in the order they weigh:
 *
 * 1. **`better-sqlite3` is synchronous.** There is no asynchronous version of
 *    this write to defer to — a `setImmediate` would move the identical blocking
 *    work later on the same event loop, buying a shorter response and a window
 *    in which a crash loses it, while making "you can find what you just said" a
 *    race rather than a guarantee.
 * 2. **It is small and it is already off the critical path.** Two primary-key
 *    reads plus one transaction holding one insert and one upsert. **Measured
 *    2026-08-24 over a file-backed database: 300 posts cost 156.3 ms without it
 *    and 227.4 ms with it — 0.237 ms per post**, against ~0.5 ms for the post
 *    itself. It runs at the END of `publishEntry`, after the room's own readers
 *    have been given the message and after the bridge hook, so nothing a reader
 *    is waiting on is behind it.
 * 3. **A room post is a hot path for a person, not for a machine.** It is bounded
 *    by how fast somebody types, and the write it already made is bigger than
 *    this one.
 *
 * @module server/services/search/write-through
 */
import type { Db } from '@dorkos/db';
import { logger } from '../../lib/logger.js';
import { roomsSource } from './registry.js';
import { indexRowContainer } from './row-frontier.js';

/**
 * Index a room entry that was just committed, or degrade to the sweep.
 *
 * @param db - The database holding both the room log and the index.
 * @param roomId - The room the entry landed in — the container, as the room
 *   projection composes it.
 * @param seq - The entry's `seq`, which is the container's ordinal high-water
 *   mark by definition: the log is append-only and this is its newest row.
 */
export function indexRoomEntry(db: Db, roomId: string, seq: number): void {
  try {
    indexRowContainer(
      db,
      roomsSource,
      // A room is not a directory, so it never has a working directory a hit
      // could open in — the same `null` the room source's own discovery writes.
      { originKey: roomId, containerPath: null, maxOrdinal: seq },
      new Date().toISOString()
    );
  } catch (err) {
    // Warn rather than error: nothing is lost and nobody needs to act. The
    // entry is durable, the room has it, and the next sweep indexes it. The line
    // exists so a write-through that is failing EVERY time is visible before
    // somebody notices search is five minutes stale.
    logger.warn('[search] write-through failed; the next sweep will catch this room up', {
      roomId,
      seq,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
