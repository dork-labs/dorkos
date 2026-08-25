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
 * 2. **It is small — ON A CAUGHT-UP CONTAINER, which is why the guard below
 *    exists.** Two primary-key reads plus one transaction holding one insert and
 *    one upsert. **Measured on a caught-up room: 300 posts cost 156.3 ms without
 *    the write-through and 227.4 ms with it — 0.237 ms per post** through the
 *    whole service, and 0.233 ms for the indexing pass alone on the standing
 *    bench. That number is the CAUGHT-UP cost and **not** the cost of the first
 *    post into a room the index has never seen: `pnpm search:write-through`
 *    measures both, and the bound below is what keeps the two apart.
 * 3. **A room post is a hot path for a person, not for a machine.** It is bounded
 *    by how fast somebody types, and the write it already made is bigger than
 *    this one.
 *
 * It runs at the END of `publishEntry`, after the room's own readers have been
 * given the message and after the bridge hook, so nothing a reader is waiting on
 * is behind it.
 *
 * @module server/services/search/write-through
 */
import type { Db } from '@dorkos/db';
import { logger } from '../../lib/logger.js';
import { roomsSource } from './registry.js';
import { containerBacklog, indexRowContainer } from './row-frontier.js';

/**
 * The most entries the write-through will project inline, before it hands the
 * room back to the sweep.
 *
 * **The per-post cost quoted above is the cost of a room the index is CAUGHT UP
 * ON.** A room it is behind on is a different question entirely: the pass resumes
 * where the index stopped, so the first post into a room with a long unindexed
 * backlog projects that whole backlog, synchronously, in `publishEntry`.
 * **Measured on a 20,000-entry room with an empty index: 406 ms for one post**
 * (review, through `publishEntry`); `pnpm search:write-through` measures the
 * indexing pass alone at 169 ms for the same depth. Either way it is a person
 * watching their message hang while history that is not urgent is caught up.
 *
 * So the write-through does what it is good at — keeping a live room live — and
 * defers what it is bad at. **200 entries** is read off that bench's curve rather
 * than chosen: cold cost is linear at ~0.009 ms per projected entry, so 200 is
 * **2.5 ms measured**, an order of magnitude under the ~50 ms at which a person
 * starts to feel a keystroke, and far above the backlog a live room accumulates
 * between two posts (which is 1). A room reaches this bound only by being
 * genuinely behind — a fresh index, a restored database, a room quiet since
 * before the index existed — and every one of those is the case the reconciler
 * was written for.
 *
 * **Deferring is not degrading.** It takes the same path a failed write-through
 * takes, which is the path §5 defines: nothing is lost, the sweep indexes the
 * room within five minutes, and the room log was the truth the whole time.
 */
const WRITE_THROUGH_MAX_BACKLOG = 200;

/**
 * Index a room entry that was just committed, or leave it to the sweep.
 *
 * @param db - The database holding both the room log and the index.
 * @param roomId - The room the entry landed in — the container, as the room
 *   projection composes it.
 * @param seq - The entry's `seq`, which is the container's ordinal high-water
 *   mark by definition: the log is append-only and this is its newest row.
 */
export function indexRoomEntry(db: Db, roomId: string, seq: number): void {
  // A room is not a directory, so it never has a working directory a hit could
  // open in — the same `null` the room source's own discovery writes.
  const container = { originKey: roomId, containerPath: null, maxOrdinal: seq };
  try {
    const backlog = containerBacklog(db, roomsSource, container);
    if (backlog > WRITE_THROUGH_MAX_BACKLOG) {
      // Debug, not warn: this is the design working. A warning here would fire on
      // every first post after a rebuild and teach whoever reads the log to
      // ignore this line, which is the one place a genuinely broken
      // write-through announces itself.
      logger.debug('[search] room is too far behind to index inline; leaving it to the sweep', {
        roomId,
        seq,
        backlog,
      });
      return;
    }
    indexRowContainer(db, roomsSource, container, new Date().toISOString());
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
