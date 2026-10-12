/**
 * Fill in who wrote a room post that reached a room-attached chat (DOR-2113),
 * at the same wire boundary {@link stampHistory} stamps chat messages at.
 *
 * A room turn's prompt is the post, word for word, so the transcript cannot say
 * who wrote it, and the app drew another agent's words as the person's own. The
 * runtime keeps only the room and entry the turn answered (a `turn_start`'s
 * `roomMessage`, or the ids read back off a stored transcript). The room and
 * the author come from the rooms domain's own records, here, every time: never
 * from the text, and never from whatever a runtime wrote into the stamp.
 *
 * The lookup is wired by the rooms subsystem at startup. With rooms off (or in
 * a test that never wires it) a stamp keeps its ids alone, and the app still
 * shows the post as from the room rather than from the person.
 *
 * @module services/session/chat-messages/room-message-stamps
 */
import type { RoomMessageAuthor, RoomMessageStamp } from '@dorkos/shared/chat-messages';

/** What the rooms domain knows about one entry: where it was posted, and by whom. */
export interface RoomMessageFacts {
  /** The room's name as people see it. */
  roomLabel: string;
  /** Who posted the entry. */
  author: RoomMessageAuthor;
}

/** Looks up one room entry, or null when the room no longer has it. */
export type RoomMessageLookup = (roomId: string, entryId: string) => RoomMessageFacts | null;

let lookup: RoomMessageLookup | undefined;

/**
 * Wire the rooms domain's lookup. Called once by the rooms subsystem at
 * startup; `undefined` unwires it.
 *
 * @param next - The lookup.
 */
export function setRoomMessageLookup(next: RoomMessageLookup | undefined): void {
  lookup = next;
}

/**
 * A stamp with its room and author filled in from the server's records.
 *
 * @param stamp - The stamp as a runtime or projector recorded it. Only its ids are read.
 * @param look - The lookup; the wired one when omitted.
 */
export function completeRoomStamp(
  stamp: RoomMessageStamp,
  look: RoomMessageLookup | undefined = lookup
): RoomMessageStamp {
  const ids = { roomId: stamp.roomId, entryId: stamp.entryId };
  const facts = look?.(stamp.roomId, stamp.entryId);
  return facts ? { ...ids, roomLabel: facts.roomLabel, author: facts.author } : ids;
}
