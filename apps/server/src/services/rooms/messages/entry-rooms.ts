/**
 * Which room holds a message, from its id alone (DOR-5046).
 *
 * A `dork:entry:<id>` link names a message and nothing else: the entry id is
 * the identity (ADR 261122-124821 §5.2), and a link carries no room. Every other
 * entry read starts from a room the caller already named, so this is the one
 * read that goes the other way.
 *
 * It decides nothing about who may see the message. The caller asks the room
 * for that, through the same checks the room's own reads use.
 *
 * @module services/rooms/messages/entry-rooms
 */
import { asc, eq, roomEntries, type Db } from '@dorkos/db';

/** Where one message sits: its room, its place there, and the thread it is in. */
export interface EntryLocation {
  /** The room the message is in. */
  roomId: string;
  /** Its place in that room's log. */
  seq: number;
  /** The message its thread hangs under, when it is a reply in one. */
  threadRootEntryId: string | null;
}

/**
 * How many rooms one id is looked for in. An entry id is a ULID minted once,
 * so one row is the rule; a few covers a room mirrored from another space that
 * carries the same message, and the cap keeps a bad id from reading a list.
 */
const MAX_ENTRY_ROOMS = 4;

/**
 * Every room that holds a message with this id, in room order then log order,
 * so the capped answer is the same on every call.
 *
 * **It is one index lookup.** `idx_room_entries_id` (migration 218, DOR-5196)
 * leads with the entry id, so a call reads only the rows that carry it, never
 * the whole table. Any caller can reach it: a person opening a `/r/` link, and
 * an agent through the `resolve_link` tool or `GET /api/links/target`.
 *
 * @param db - The server database.
 * @param entryId - The message's id, exactly as minted.
 * @returns Where it sits, one location per room that holds it.
 */
export function entryLocations(db: Db, entryId: string): EntryLocation[] {
  return db
    .select({
      roomId: roomEntries.roomId,
      seq: roomEntries.seq,
      threadRootEntryId: roomEntries.threadRootEntryId,
    })
    .from(roomEntries)
    .where(eq(roomEntries.id, entryId))
    .orderBy(asc(roomEntries.roomId), asc(roomEntries.seq))
    .limit(MAX_ENTRY_ROOMS)
    .all();
}
