/**
 * Persistence for reactions on room entries (`specs/room-messaging-design` §2).
 *
 * It sits beside {@link RoomStore} rather than inside it for one honest reason:
 * that class is already the largest file in this domain, and reactions bring a
 * different key shape, a different ordering rule and a cross-room aggregate
 * that has nothing to do with a room's log. Synchronous throughout, like every
 * other store here (`better-sqlite3`), so a toggle is one transaction with no
 * await inside it.
 *
 * Two things this module deliberately does NOT own. It never decides **who** may
 * react — that is conduct, and it lives in `RoomService.toggleReaction`. And it
 * never publishes: the stream is the service's, so a store that fanned out would
 * be a second place a reaction could be announced from.
 *
 * @module server/services/rooms/reaction-store
 */
import { roomEntryReactions, and, eq, inArray, desc, sql, count, type Db } from '@dorkos/db';
import {
  REACTION_FREQUENTS_COUNT,
  REACTION_FREQUENTS_DEFAULT,
  type RoomEntryReaction,
} from '@dorkos/shared/room-schemas';

/** Everything one reaction is: where it sits, who left it, and what it is. */
export interface ReactionKey {
  roomId: string;
  entryId: string;
  authorId: string;
  emoji: string;
}

/** Reads and writes over `room_entry_reactions`. */
export class ReactionStore {
  constructor(private readonly db: Db) {}

  /**
   * Put this reaction into a named state, or flip whatever is there.
   *
   * **Flipping (`on` omitted) deletes first and inserts only if nothing was
   * deleted.** The obvious shape is read-then-branch, and it has a race a
   * double-fired click reaches: two requests both read "not reacted", both
   * insert, and the second hits the primary key as a 500 the person cannot act
   * on. Here the DELETE's own `changes` count IS the branch, so exactly one of
   * the two statements runs and the answer is whatever the row state was.
   *
   * **Naming a state makes the call idempotent in effect**, which is what a
   * client that might retry needs: a retried flip undoes the thing it just did.
   * The `on: true` arm deliberately does NOT delete-then-insert — that would
   * mint a fresh `createdAt` and move the pill to the end of a row ordered by
   * first appearance, so a retry would visibly shove the reader's pills around.
   * It inserts and lets the primary key absorb the duplicate, keeping the
   * original timestamp.
   *
   * The transaction is **IMMEDIATE** for the reason
   * {@link RoomStore.appendEntry} is: a deferred one takes a read lock for the
   * delete and cannot upgrade it if another writer got in between, which SQLite
   * reports as `SQLITE_BUSY_SNAPSHOT` and does not retry.
   *
   * @param key - The room, entry, author and emoji.
   * @param createdAt - When it landed, ISO 8601. Unused when this removes one,
   *   and unused when `on: true` finds the reaction already there.
   * @param on - The state to land in. Omit to flip.
   * @returns `true` when the reaction is now ON, `false` when it is off.
   */
  set(key: ReactionKey, createdAt: string, on?: boolean): boolean {
    return this.db.transaction(
      (tx) => {
        if (on === true) {
          tx.insert(roomEntryReactions)
            .values({ ...key, createdAt })
            .onConflictDoNothing()
            .run();
          return true;
        }
        const removed = tx
          .delete(roomEntryReactions)
          .where(
            and(
              eq(roomEntryReactions.roomId, key.roomId),
              eq(roomEntryReactions.entryId, key.entryId),
              eq(roomEntryReactions.authorId, key.authorId),
              eq(roomEntryReactions.emoji, key.emoji)
            )
          )
          .run();
        if (on === false || removed.changes > 0) return false;
        tx.insert(roomEntryReactions)
          .values({ ...key, createdAt })
          .run();
        return true;
      },
      { behavior: 'immediate' }
    );
  }

  /**
   * Whether this exact reaction is standing right now.
   *
   * The one caller is the agent rate bound (ADR 260814-195522), which spends only
   * on a reaction that will LAND: without this it could not tell an addition from
   * a retraction or from a no-op re-assert, and would charge all three. Reading
   * the primary key directly rather than through {@link ReactionStore.listFor},
   * which would fetch and group an entry's whole pill row to answer a yes/no.
   *
   * @param key - The room, entry, author and emoji.
   * @returns `true` when the row exists.
   */
  has(key: ReactionKey): boolean {
    return (
      this.db
        .select({ emoji: roomEntryReactions.emoji })
        .from(roomEntryReactions)
        .where(
          and(
            eq(roomEntryReactions.roomId, key.roomId),
            eq(roomEntryReactions.entryId, key.entryId),
            eq(roomEntryReactions.authorId, key.authorId),
            eq(roomEntryReactions.emoji, key.emoji)
          )
        )
        .get() !== undefined
    );
  }

  /**
   * The reactions on several entries at once, grouped by entry then by emoji.
   *
   * Batched for the reason {@link RoomStore.countThreadRepliesFor} is: a page of
   * fifty entries would otherwise be fifty round trips to decorate a pill row
   * nobody asked for one message at a time. Both readers take this — the history
   * page and the agent's own acknowledgment window — so there is one query shape
   * and one ordering rule rather than two that could drift.
   *
   * **Ordered by when each reaction landed, never by count.** A pill that jumped
   * left every time somebody else joined it would move under the reader's cursor
   * mid-click.
   *
   * **Then by author, then by emoji, and both tiebreaks are load-bearing.** A
   * millisecond is long enough to hold two reactions and `createdAt` is the only
   * clock this table has, so a tie is not a corner case: one click on a quick row
   * with two emoji in it produces two rows written in the same millisecond by the
   * same person. With nothing after `createdAt` the order of those falls to
   * whatever the planner scans, which made a test that asserted the pill row
   * flaky — the same failure {@link RoomStore.listMembers} records about a seeded
   * roster, found the same way. Adding `emoji` last makes the answer total: two
   * installs holding identical rows draw identical rows.
   *
   * @param roomId - The room the entries live in.
   * @param entryIds - The entries to read. An empty list reads nothing.
   * @returns One list per entry that HAS reactions; an entry with none is absent.
   */
  listFor(roomId: string, entryIds: readonly string[]): Map<string, RoomEntryReaction[]> {
    const grouped = new Map<string, RoomEntryReaction[]>();
    const wanted = [...new Set(entryIds)];
    if (wanted.length === 0) return grouped;
    const rows = this.db
      .select()
      .from(roomEntryReactions)
      .where(
        and(eq(roomEntryReactions.roomId, roomId), inArray(roomEntryReactions.entryId, wanted))
      )
      .orderBy(
        roomEntryReactions.entryId,
        roomEntryReactions.createdAt,
        roomEntryReactions.authorId,
        roomEntryReactions.emoji
      )
      .all();

    for (const row of rows) {
      let pills = grouped.get(row.entryId);
      if (!pills) {
        pills = [];
        grouped.set(row.entryId, pills);
      }
      // Rows arrive oldest-first, so the first sighting of an emoji is its
      // `firstAt` and appending keeps `authorIds` in the order people reacted.
      const pill = pills.find((existing) => existing.emoji === row.emoji);
      if (pill) pill.authorIds.push(row.authorId);
      else pills.push({ emoji: row.emoji, authorIds: [row.authorId], firstAt: row.createdAt });
    }
    return grouped;
  }

  /**
   * One entry's reactions right now — what a reaction event carries.
   *
   * @param roomId - The room.
   * @param entryId - The entry.
   */
  listForEntry(roomId: string, entryId: string): RoomEntryReaction[] {
    return this.listFor(roomId, [entryId]).get(entryId) ?? [];
  }

  /**
   * One person's quick row: their most-used emoji, most-used first, always
   * exactly {@link REACTION_FREQUENTS_COUNT} of them.
   *
   * **Derived, not tracked.** There is no counter table and no usage log — one
   * `GROUP BY` over the rows this person already owns answers it, and the index
   * `(author_id, emoji)` confines the read to those rows and hands them over
   * already grouped by emoji. It does NOT remove the sort, and the plan says so:
   * `SEARCH … USING INDEX idx_room_entry_reactions_author` then
   * `USE TEMP B-TREE FOR ORDER BY`. Nothing could — the ordering is by `COUNT(*)`,
   * and no index holds an aggregate. The B-tree is over one person's distinct
   * emoji, which is a handful of rows, so the cost is fine; the point of the
   * index is the search, not the ordering. The honest consequence of deriving at
   * all is that it counts reactions that are still STANDING: taking a pill back also
   * un-counts it. A literal most-ever-used would need a second table to hold
   * history nobody asked to keep, and the row it produced would be no better —
   * an emoji you used once and regretted does not belong in the row you reach
   * for.
   *
   * Cross-room on purpose. Reaction habits are a person's, not a room's, and a
   * quick row that reset when you opened a new channel would be a row you could
   * never learn.
   *
   * Padded from {@link REACTION_FREQUENTS_DEFAULT} so the row is always full: a
   * capsule whose leftmost slots appeared one at a time as history accumulated
   * would reflow under the pointer for weeks.
   *
   * @param authorId - Whose row to compute.
   */
  frequents(authorId: string): string[] {
    const rows = this.db
      .select({
        emoji: roomEntryReactions.emoji,
        uses: count(),
        lastAt: sql<string>`MAX(${roomEntryReactions.createdAt})`,
      })
      .from(roomEntryReactions)
      .where(eq(roomEntryReactions.authorId, authorId))
      .groupBy(roomEntryReactions.emoji)
      // Recency breaks a tie on count, and the emoji itself breaks a tie on
      // both — otherwise a person with three single uses gets a different row
      // on every request, from data that never changed.
      .orderBy(
        desc(count()),
        desc(sql`MAX(${roomEntryReactions.createdAt})`),
        roomEntryReactions.emoji
      )
      .limit(REACTION_FREQUENTS_COUNT)
      .all();

    const row = rows.map((used) => used.emoji);
    for (const fallback of REACTION_FREQUENTS_DEFAULT) {
      if (row.length >= REACTION_FREQUENTS_COUNT) break;
      if (!row.includes(fallback)) row.push(fallback);
    }
    return row;
  }
}
