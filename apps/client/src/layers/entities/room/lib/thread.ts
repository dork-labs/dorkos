/**
 * Where an entry sits in its thread, and what replying to it aims at.
 *
 * A thread is a relation between entries in one room's log, not a room of its
 * own (ADR 260728-022013), so "which thread is this in?" is a question about a
 * single entry and answering it needs nothing else loaded.
 *
 * @module entities/room/lib/thread
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';

/**
 * The entry heading this entry's thread, or `null` when it heads its own.
 *
 * Reads `threadRootEntryId` and falls back to `parentEntryId`. The fallback is
 * not decoration: the two pointers are written together and pinned equal by a
 * server test, but that invariant is not yet a `CHECK` constraint, so a
 * hand-written row can still carry one without the other.
 *
 * @param entry - The entry to place.
 */
export function threadRootIdOf(entry: RoomEntry): string | null {
  return entry.threadRootEntryId ?? entry.parentEntryId;
}

/**
 * The entry a reply to this one must hang off.
 *
 * **Replying to a reply aims at the root**, because the server refuses anything
 * deeper (`NESTED_THREAD`, 400) and a refusal here would be an error message
 * about our own interface. Retargeting is also what the reader already sees:
 * the timeline draws one level, so the thread they are answering into is the
 * root's, whichever line inside it they pressed.
 *
 * @param entry - The entry the reader chose to answer.
 * @returns The id to send as `rootEntryId` — the entry itself when it heads a
 *   thread, otherwise the entry that does.
 */
export function replyRootFor(entry: RoomEntry): string {
  return threadRootIdOf(entry) ?? entry.id;
}

/** What the "↳ N replies · last 9:45 AM" row under a thread root says. */
export interface ThreadReplySummary {
  /** How many replies the thread holds. Never zero — no replies, no row. */
  count: number;
  /** When the newest of them was written, as its stored ISO timestamp. */
  lastAt: string;
  /** How many of them are above the reader's cursor. Zero means no accent. */
  unread: number;
}

/**
 * Reduce a thread's replies to the three numbers its row in the timeline reads.
 *
 * **The unread count is derived, not stored** (design record §3.3): a reply is
 * unread when its `seq` is above the reader's `(member, room)` cursor, which is
 * the same cursor the unread rule is placed from and the same one the sidebar
 * badge counts against. No schema, no second cursor, and nothing that can drift
 * from the rule drawn a few pixels away.
 *
 * The cursor handed in should be the FROZEN one (`useFrozenReadCursor`), not
 * the live membership value, and that is what makes the count mean anything at
 * all: opening a room advances the real cursor past every thread reply in it
 * (`groupByThread` explains why, and what it costs), so a row reading the live
 * value would show its accent for one frame and then lose it. Read from the
 * frozen cursor, the accent says "these arrived since you last looked" on the
 * way in, and ticks up for anything that lands while you are watching — which
 * is the same promise the unread rule above it makes.
 *
 * `null` is a reader with no cursor — not a member of this room — and they are
 * told nothing is unread rather than that everything is. It is the answer the
 * unread rule gives them too.
 *
 * **Requires at least one reply, and that is a real precondition rather than a
 * hedge.** A thread with no replies has no row — `groupByThread` only ever
 * creates a key once something hangs off it, so an empty array cannot reach
 * here from the timeline, and `ThreadReplyRow` is not rendered without one.
 * Returning a zero-summary instead would invent a `lastAt` for a message that
 * does not exist, and every caller would have to decide what to draw for it. It
 * is pinned from both ends: the invariant is tested on `groupByThread`, and the
 * empty case is tested here so the failure stays loud rather than becoming a
 * silent `NaN` in a row somebody reads.
 *
 * @param replies - One thread's replies, at least one. Order is not assumed.
 * @throws TypeError when handed an empty array — see above.
 * @param lastReadSeq - The reader's read cursor, or `null` when they are not a
 *   member of this room.
 */
export function threadReplySummary(
  replies: readonly RoomEntry[],
  lastReadSeq: number | null
): ThreadReplySummary {
  let newest = replies[0]!;
  let unread = 0;
  for (const reply of replies) {
    // `seq` and not `createdAt`: the log's order is the room's own, and two
    // writers whose clocks disagree must not be able to change which reply the
    // row calls the last one.
    if (reply.seq > newest.seq) newest = reply;
    if (lastReadSeq !== null && reply.seq > lastReadSeq) unread += 1;
  }
  return { count: replies.length, lastAt: newest.createdAt, unread };
}
