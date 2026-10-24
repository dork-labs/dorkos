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
import { roomEntries, eq, sql, type Db } from '@dorkos/db';
import { ROOM_LAST_LINE_MAX_CHARS, ROOM_MENTION_COUNT_CAP } from '@dorkos/shared/room-schemas';
import { parseEntryBody } from '../room-rows.js';

/**
 * Basic markdown taken out of a message, so a one-line preview reads as words
 * rather than syntax. Not a parser: it removes the marks people actually type
 * in a chat — code fences, inline code, bold, strike, links, images, and a
 * heading or quote mark at the start of a line — and leaves everything else.
 *
 * @param text - The message text.
 */
function stripBasicMarkdown(text: string): string {
  return (
    text
      // A fence line, with its language tag. The code inside stays: it is
      // often the whole message.
      .replace(/^\s*(```|~~~)[^\n]*$/gm, '')
      // `![alt](src)` → alt, then `[label](href)` → label.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|~~|`/g, '')
      .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, '')
  );
}

/**
 * One line of a message, as a row tooltip shows it: basic markdown taken out,
 * whitespace collapsed to single spaces, cut to {@link ROOM_LAST_LINE_MAX_CHARS}
 * with no ellipsis.
 *
 * A cut that would split an emoji's surrogate pair drops the stray half, so
 * the text never ends in a broken character.
 *
 * @param text - The message text.
 * @returns The line, or `null` when nothing is left once markdown and
 *   whitespace go.
 */
export function toLastLine(text: string): string | null {
  const flat = stripBasicMarkdown(text).replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  let cut = flat.slice(0, ROOM_LAST_LINE_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length < flat.length && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** One room a {@link RoomListReads.lastLines} call asks about. */
export interface LastLineRequest {
  /** The room. */
  roomId: string;
  /**
   * The exclusive `seq` floor: only entries above it may be shown. `0` reads
   * the whole log; a member who is not the owner passes their `joinedSeq`,
   * because what was said before they arrived is not theirs to read.
   */
  floor: number;
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
   * How many entries above a read cursor @mention one author, counted up to
   * {@link ROOM_MENTION_COUNT_CAP} — `RoomSummary.mentionCount`.
   *
   * The same window `RoomStore.countUnread` counts, narrowed to the entries
   * whose resolved `mentions` array holds this author. Thread replies count,
   * because the cursor they sit above is the room's one cursor and reading the
   * room clears them along with everything else.
   *
   * **Capped, because nothing reads past the cap.** The sidebar draws anything
   * over nine as `9+`, so the count stops at ten: a room with four hundred
   * unread mentions costs ten matches, not a walk of everything above the
   * cursor.
   *
   * **From the log, never from notifications.** A notification is a delivery
   * that can be dismissed, deduplicated or never sent; the entry and its
   * resolved mentions are the fact, so this badge and the room's own unread
   * count clear together and for the same reason.
   *
   * An author naming themselves is not counted: nobody is being asked for
   * anything by their own words. Columns are written unqualified on purpose,
   * so this per-room read is not mistaken for the one whole-list author read
   * the room list makes ({@link RoomListReads.roomsPostedInBy}).
   *
   * @param roomId - The room.
   * @param lastReadSeq - The reader's cursor.
   * @param authorId - Whose mentions to count.
   * @returns The count, at most {@link ROOM_MENTION_COUNT_CAP}.
   */
  countUnreadMentions(roomId: string, lastReadSeq: number, authorId: string): number {
    const row = this.db.get<{ value: number }>(sql`
      SELECT COUNT(*) AS value FROM (
        SELECT 1 FROM room_entries
        WHERE room_id = ${roomId}
          AND seq > ${lastReadSeq}
          AND author_id <> ${authorId}
          AND EXISTS (SELECT 1 FROM json_each(mentions) WHERE value = ${authorId})
        LIMIT ${ROOM_MENTION_COUNT_CAP}
      )`);
    return row?.value ?? 0;
  }

  /**
   * The newest top-level message's line in each room — `RoomSummary.lastLine`
   * for a whole list, in one query.
   *
   * **It starts from the rooms asked about, not from the log.** The outer
   * query walks the request list (`json_each`), and for each room a subquery
   * reads the `(room_id, seq)` primary key backwards from the newest entry and
   * stops at the first one that is top-level and above the floor. So a room
   * costs the thread replies written after its last top-level message, and
   * never its history — the plan is a search on the primary key, never a scan
   * of `room_entries`.
   *
   * @param requests - The rooms to read, each with the floor its viewer may
   *   read above.
   * @returns Room id to its line. `null` when the newest readable top-level
   *   message has no text, or there is none.
   */
  lastLines(requests: readonly LastLineRequest[]): Map<string, string | null> {
    if (requests.length === 0) return new Map();
    const wanted = JSON.stringify(requests.map((request) => [request.roomId, request.floor]));
    const rows = this.db.all<{ roomId: string; body: string | null }>(sql`
      SELECT
        json_extract(wanted.value, '$[0]') AS roomId,
        (
          SELECT n.body FROM room_entries AS n
          WHERE n.room_id = json_extract(wanted.value, '$[0]')
            AND n.seq > json_extract(wanted.value, '$[1]')
            AND n.thread_root_entry_id IS NULL
          ORDER BY n.seq DESC
          LIMIT 1
        ) AS body
      FROM json_each(${wanted}) AS wanted`);
    return new Map(
      rows.map((row) => {
        if (row.body === null) return [row.roomId, null];
        // A body that is not the JSON we wrote parses to whatever it holds, so
        // its `text` is checked rather than trusted.
        const text: unknown = parseEntryBody(row.body).text;
        return [row.roomId, toLastLine(typeof text === 'string' ? text : '')];
      })
    );
  }
}
