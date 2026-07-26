/**
 * Pure display helpers for rooms and the people in them.
 *
 * @module entities/room/lib/room-display
 */
import type { Room, RoomSummary } from '@dorkos/shared/room-schemas';
import { hashToHslColor } from '@/layers/shared/lib';

/** Glyph a display name with no letter or digit falls back to. */
const FALLBACK_INITIAL = '?';

/** A room object with just enough on it to render a title. */
type TitleableRoom = Pick<Room, 'kind' | 'slug' | 'title'>;

/**
 * What a room is called on screen.
 *
 * A channel reads as its `#slug`, because that is the name people type and the
 * one the server enforces as unique. Everything else reads as its title.
 *
 * @param room - The room to name.
 */
export function roomDisplayTitle(room: TitleableRoom): string {
  if (room.kind === 'channel' && room.slug) return `#${room.slug}`;
  return room.title;
}

/**
 * First letter or digit of a name, uppercased — the letter avatar's glyph.
 *
 * @param name - The display name to take an initial from.
 */
export function initialOf(name: string): string {
  const match = /\p{L}|\p{N}/u.exec(name);
  return match ? match[0].toUpperCase() : FALLBACK_INITIAL;
}

/**
 * The color that stands for one participant, everywhere.
 *
 * Hashed from the opaque author id, so an author reads as the same color in
 * every room and across reloads without the server having to pick one.
 *
 * @param authorId - The author's opaque id.
 */
export function authorColor(authorId: string): string {
  return hashToHslColor(authorId);
}

/**
 * Whether an unread badge should be drawn for a room.
 *
 * `unreadCount` is `null` when the caller is not a member of the room, which is
 * "not applicable" and not zero. Collapsing the two would badge every room the
 * operator has only ever looked at.
 *
 * @param room - The room summary from the list.
 */
export function hasUnread(room: RoomSummary): boolean {
  return room.unreadCount !== null && room.unreadCount > 0;
}
