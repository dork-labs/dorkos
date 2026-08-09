/**
 * Pure rules for how rooms behave inside the command palette (spec `rooms`
 * §13.2): what order they come in, what a row is called, and where selecting
 * one lands.
 *
 * Kept free of React so the ordering claim — the headline of this change — can
 * be asserted directly rather than inferred from a rendered list.
 *
 * @module features/command-palette/model/palette-rooms
 */
import { hasUnread, type RoomSummary } from '@/layers/entities/room';

/**
 * How two rooms compare in the palette: live rooms before archived ones,
 * anything unread first within each, then whichever spoke last.
 *
 * This is deliberately not the sidebar's order. The sidebar sorts channels by
 * name so the list stops moving and you learn where rows are
 * (`useRoomsByKind`); the palette is a ranked answer to "what needs me", where
 * a stable position buys nothing and burying the unread room under an
 * alphabetically luckier one costs the whole feature.
 *
 * **Archived outranks even unread, downwards.** The palette is the one place an
 * archived room appears at all (DOR-1051) — so that a channel somebody closed
 * can still be FOUND, not so it can compete with a conversation still going. A
 * closed channel can easily be both the last thing that spoke and owed a read,
 * which is exactly how it would otherwise reach the top of the list.
 *
 * `hasUnread` decides the next key rather than `unreadCount` directly, because
 * `null` means "you are not in this room" and is not zero — see its own doc.
 *
 * `lastActivityAt` is always a UTC ISO-8601 timestamp, so comparing the strings
 * compares the instants. The id breaks the tie in the same descending
 * direction, so rooms that tie never swap places between renders.
 */
export function compareRoomsForPalette(a: RoomSummary, b: RoomSummary): number {
  const liveFirst = Number(a.archived) - Number(b.archived);
  if (liveFirst !== 0) return liveFirst;
  const unreadFirst = Number(hasUnread(b)) - Number(hasUnread(a));
  if (unreadFirst !== 0) return unreadFirst;
  return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id);
}

/**
 * A room list in palette order — unread first, then by recency.
 *
 * Copies before sorting: the input is the TanStack Query cache's own array, and
 * sorting it in place would reorder every other reader of that cache.
 *
 * @param rooms - The rooms to order.
 */
export function sortRoomsForPalette(rooms: readonly RoomSummary[]): RoomSummary[] {
  return [...rooms].sort(compareRoomsForPalette);
}

/**
 * The words a palette row for a room is searched by.
 *
 * The name is the spoken form (`#general`), so the row reads as its own label
 * in any list that shows the match. The keywords carry the bare slug and the
 * title as well, so typing `#gen` — which arrives with the prefix already
 * stripped — hits `general` exactly instead of relying on a fuzzy match against
 * the `#`.
 *
 * A direct message adds everyone in it, so `@ana` finds a group conversation
 * Ana is in and not only the one named after her.
 *
 * @param room - The room to describe.
 */
export function paletteRoomKeywords(room: RoomSummary): string[] {
  const words = [room.title];
  if (room.slug) words.push(room.slug);
  for (const author of room.participants ?? []) words.push(author.displayName);
  return words;
}
