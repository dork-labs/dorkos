/**
 * The per-viewer facts a room list carries beside each room, read straight
 * from the log: whether the viewer ever wrote there, how many unread entries
 * name them, and what the room's last line says.
 *
 * Split from `RoomStore` on a real boundary: every read here answers one
 * question about the sidebar's list of rooms, and nothing else in the server
 * asks them. Each is derived from `room_entries` on every read, never stored,
 * so none of them can drift from the messages they describe.
 *
 * @module server/services/rooms/manage/room-list-reads
 */
import { roomEntries, and, count, eq, gt, inArray, sql, type Db } from '@dorkos/db';
import { ROOM_LAST_LINE_MAX_CHARS } from '@dorkos/shared/room-schemas';
import { parseEntryBody } from '../room-rows.js';

/**
 * One line of a message, as a row tooltip shows it: whitespace collapsed to
 * single spaces, cut to {@link ROOM_LAST_LINE_MAX_CHARS} with no ellipsis.
 *
 * A cut that would split an emoji's surrogate pair drops the stray half, so
 * the text never ends in a broken character.
 *
 * @param text - The message text.
 * @returns The line, or `null` when nothing is left once whitespace goes.
 */
export function toLastLine(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  let cut = flat.slice(0, ROOM_LAST_LINE_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length < flat.length && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Reads over `room_entries` that serve the room list, one viewer at a time. */
export class RoomListReads {
  constructor(private readonly db: Db) {}

  /**
   * Every room this author has written in — `RoomSummary.viewerHasPosted` for a
   * whole list, in one query.
   *
   * **One query for the list, not one per room.** The obvious per-room spelling
   * is an `EXISTS` against `(room_id, seq)`, and it is the wrong shape twice
   * over: it is N queries for an N-room sidebar, and each one proves "never"
   * only by walking that room's entire log. This reads
   * `idx_room_entries_author_room` instead, whose whole reason to exist is this
   * question.
   *
   * **Every entry under a person's author id is something they wrote.** No
   * `kind` filter, because there is nothing to filter: a `notice` is authored by
   * the system author (`RoomService.postNotice`) and so is a milestone the room
   * mints for somebody, so an entry can only carry this author id if this author
   * posted it.
   *
   * @param authorId - Whose writing to look for.
   * @returns The ids of the rooms they have posted in. Empty for somebody who
   *   has never written anywhere, which is the answer a fresh install gives.
   */
  roomsPostedInBy(authorId: string): Set<string> {
    const rows = this.db
      .selectDistinct({ roomId: roomEntries.roomId })
      .from(roomEntries)
      .where(eq(roomEntries.authorId, authorId))
      .all();
    return new Set(rows.map((row) => row.roomId));
  }

  /**
   * How many entries above a read cursor @mention one author —
   * `RoomSummary.mentionCount`.
   *
   * The same window `RoomStore.countUnread` counts, narrowed to the entries
   * whose resolved `mentions` array holds this author. Thread replies count,
   * because the cursor they sit above is the room's one cursor and reading the
   * room clears them along with everything else.
   *
   * **From the log, never from notifications.** A notification is a delivery
   * that can be dismissed, deduplicated or never sent; the entry and its
   * resolved mentions are the fact, so this badge and the room's own unread
   * count clear together and for the same reason.
   *
   * An author naming themselves is not counted: nobody is being asked for
   * anything by their own words. The column is written unqualified on purpose,
   * so this per-room read is not mistaken for the one whole-list author read
   * the room list makes ({@link RoomListReads.roomsPostedInBy}).
   *
   * @param roomId - The room.
   * @param lastReadSeq - The reader's cursor.
   * @param authorId - Whose mentions to count.
   */
  countUnreadMentions(roomId: string, lastReadSeq: number, authorId: string): number {
    const row = this.db
      .select({ value: count() })
      .from(roomEntries)
      .where(
        and(
          eq(roomEntries.roomId, roomId),
          gt(roomEntries.seq, lastReadSeq),
          sql`author_id <> ${authorId}`,
          sql`EXISTS (SELECT 1 FROM json_each(${roomEntries.mentions}) WHERE value = ${authorId})`
        )
      )
      .get();
    return row?.value ?? 0;
  }

  /**
   * The newest top-level message's line in each room — `RoomSummary.lastLine`
   * for a whole list, in one query.
   *
   * Per room, the subquery walks the `(room_id, seq)` primary key backwards and
   * stops at the first entry that is not a thread reply, so a room's cost is
   * the replies that came after its last top-level message, never its log.
   *
   * @param roomIds - The rooms to read.
   * @returns Room id to its line, or `null` when the newest top-level message
   *   has no text. A room with no top-level message at all is absent.
   */
  lastLines(roomIds: readonly string[]): Map<string, string | null> {
    if (roomIds.length === 0) return new Map();
    const rows = this.db
      .select({ roomId: roomEntries.roomId, body: roomEntries.body })
      .from(roomEntries)
      .where(
        and(
          inArray(roomEntries.roomId, [...new Set(roomIds)]),
          eq(
            roomEntries.seq,
            sql`(SELECT newest.seq FROM room_entries AS newest WHERE newest.room_id = ${roomEntries.roomId} AND newest.thread_root_entry_id IS NULL ORDER BY newest.seq DESC LIMIT 1)`
          )
        )
      )
      .all();
    return new Map(
      rows.map((row) => {
        // A body that is not the JSON we wrote parses to whatever it holds, so
        // its `text` is checked rather than trusted.
        const text: unknown = parseEntryBody(row.body).text;
        return [row.roomId, toLastLine(typeof text === 'string' ? text : '')];
      })
    );
  }
}
