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
import { hasUnread, roomDisplayTitle, type RoomSummary } from '@/layers/entities/room';

/** Where a room opens: the `/channels` search params that address it. */
export interface PaletteRoomTarget {
  /** The top-level room. For a thread this is the room it hangs off. */
  id: string;
  /** Set only for a thread — the child room that renders. */
  thread?: string;
}

/**
 * How two rooms compare in the palette: anything unread first, then whichever
 * spoke last.
 *
 * This is deliberately not the sidebar's order. The sidebar sorts channels by
 * name so the list stops moving and you learn where rows are
 * (`useRoomsByKind`); the palette is a ranked answer to "what needs me", where
 * a stable position buys nothing and burying the unread room under an
 * alphabetically luckier one costs the whole feature.
 *
 * `hasUnread` decides the first key rather than `unreadCount` directly, because
 * `null` means "you are not in this room" and is not zero — see its own doc.
 *
 * `lastActivityAt` is always a UTC ISO-8601 timestamp, so comparing the strings
 * compares the instants. The id breaks the tie in the same descending
 * direction, so rooms that tie never swap places between renders.
 */
export function compareRoomsForPalette(a: RoomSummary, b: RoomSummary): number {
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
 * Where selecting a room in the palette navigates to.
 *
 * A room's identity travels as a `/channels` search param (`channelsSearchSchema`).
 * A thread carries both: its parent stays in `id` so leaving the thread returns
 * to the room it hangs off, exactly as the route documents.
 *
 * A thread whose `parentId` is missing — which the schema says cannot happen,
 * but a hand-written payload can — addresses itself rather than navigating
 * nowhere.
 *
 * @param room - The room the operator picked.
 */
export function paletteRoomTarget(room: RoomSummary): PaletteRoomTarget {
  if (room.kind === 'thread' && room.parentId) {
    return { id: room.parentId, thread: room.id };
  }
  return { id: room.id };
}

/**
 * The breadcrumb a thread row shows in front of its own name — the room it
 * hangs off, written the way people say it, so a thread reads as
 * `#general › Deploy fallout` rather than as a title with no home.
 *
 * Answers `null` for anything that is not a thread, and for a thread whose
 * parent is not in the list the palette can see (an archived room, or one this
 * operator cannot read). A missing parent drops the breadcrumb rather than
 * inventing one.
 *
 * @param room - The room being rendered.
 * @param byId - Every room the palette holds, keyed by id.
 */
export function threadParentLabel(
  room: RoomSummary,
  byId: ReadonlyMap<string, RoomSummary>
): string | null {
  if (room.kind !== 'thread' || !room.parentId) return null;
  const parent = byId.get(room.parentId);
  return parent ? roomDisplayTitle(parent) : null;
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
