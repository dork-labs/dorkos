/**
 * What the room sheet is opened with.
 *
 * Two types, kept out of any one of the sheet's parts: the header, the shell and
 * the four entry points all name them, and a type living inside the component
 * that happens to render it makes every sibling import that component.
 *
 * @module features/room-management/model/room-details
 */
import type { Room } from '@dorkos/shared/room-schemas';

/**
 * Which part of the sheet the reader asked for, so that part gets the focus.
 *
 * Named for what the reader wanted rather than for a section of a file: the
 * sheet holds everything about a room, and an entry point that says `'topic'` is
 * describing its own menu item rather than predicting a layout.
 */
export type RoomDetailsFocus = 'members' | 'add' | 'topic';

/**
 * The least the sheet needs to know about a room before it reads one.
 *
 * Deliberately narrower than `RoomSummary`: the entry points spec §14.3 names
 * hold different shapes — a sidebar row has a `RoomSummary`, the open room has a
 * `RoomWithRoster` — and neither is assignable to the other. Every field here is
 * on `RoomSchema`, so both satisfy it.
 *
 * It carries more than an id because the sheet draws its header before the
 * roster read lands. Without `topic` and `archived` the header would flicker
 * through a state where the room has neither, which is a claim rather than a
 * gap.
 */
export type RoomDetailsRoom = Pick<
  Room,
  'id' | 'kind' | 'slug' | 'title' | 'topic' | 'archived' | 'createdAt'
>;
