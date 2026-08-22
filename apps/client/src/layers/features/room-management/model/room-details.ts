/**
 * What the room panel is opened with.
 *
 * Two types, kept out of any one of the panel's parts: the header, the footer
 * and the three entry points all name them, and a type living inside the
 * component that happens to render it makes every sibling import that component.
 *
 * @module features/room-management/model/room-details
 */
import type { Room } from '@dorkos/shared/room-schemas';

/**
 * Which part of the panel the reader asked for, so that part gets the focus.
 *
 * Named for what the reader wanted rather than for a section of a file: the
 * panel holds everything about a room, and an entry point that says `'topic'` is
 * describing its own menu item rather than predicting a layout. That is what let
 * the whole union survive the move out of the modal untouched.
 */
export type RoomDetailsFocus = 'members' | 'add' | 'topic';

/**
 * The least a part of this slice needs to know about a room to draw it.
 *
 * Deliberately narrower than `RoomSummary`: the surfaces that hand a room in
 * hold different shapes — a sidebar row has a `RoomSummary`, an open room has a
 * `RoomWithRoster` — and neither is assignable to the other. Every field here is
 * on `RoomSchema`, so both satisfy it.
 */
export type RoomDetailsRoom = Pick<
  Room,
  'id' | 'kind' | 'slug' | 'title' | 'topic' | 'archived' | 'createdAt' | 'bridge'
>;
