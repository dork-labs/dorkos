/**
 * Pure display helpers for rooms and the people in them.
 *
 * @module entities/room/lib/room-display
 */
import type { AuthorRef, Room, RoomSummary } from '@dorkos/shared/room-schemas';
import { hashToHslColor } from '@/layers/shared/lib';

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
 * Who a direct message is with.
 *
 * A DM is the operator and one agent, so the counterpart is the agent on the
 * roster — picked by `kind` rather than by position, because matching on a
 * rendered name never was a promise.
 *
 * "The first agent" is only an answer because the server orders a roster
 * deterministically (`RoomStore.listMembers`): oldest membership first, author
 * id breaking the tie that every seeded roster has. Nothing here re-sorts, so
 * the sidebar and the open room's header name the same agent. A DM holding two
 * agents — which `POST /:id/members` permits — gets the first of them and no
 * hint that there is a second; drawing a group is a design question, not a
 * tiebreak, and it belongs with whoever takes it on.
 *
 * @param participants - The DM's roster, as `RoomSummary.participants` carries
 *   it. `null` (a channel, a thread, or a payload that predates the field) and
 *   a roster with no agent on it both answer `null`, which is the caller's cue
 *   to fall back to the room itself.
 */
export function dmCounterpart(
  participants: readonly AuthorRef[] | null | undefined
): AuthorRef | null {
  return participants?.find((author) => author.kind === 'agent') ?? null;
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
