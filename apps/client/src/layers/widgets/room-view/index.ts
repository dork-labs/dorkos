/**
 * Room view widget — a room's history at `/channels` (spec `rooms` §7).
 *
 * @module widgets/room-view
 */
export { ChannelsPage } from './ui/ChannelsPage';
/**
 * One row of a room's history, exported for the Dev Playground's entry-actions
 * bench (`/dev/entry-actions`) — the surface a reviewer eyeballs the hover
 * toolbar on. The playground's rule is that it renders the REAL component and
 * never a copy of its markup, and this row's toolbar is held in place by
 * layout the row itself owns, so a copy would be the one thing that cannot
 * catch a layout defect. Nothing in the routed app imports it from here.
 */
export { RoomEntryRow } from './ui/RoomEntryRow';
/**
 * The thread side panel and its "N replies" row under a thread root, exported
 * for the Dev Playground's thread bench (`/dev/rooms`) for the same reason
 * `RoomEntryRow` is: the playground renders the real components, never a copy
 * of their markup. Nothing in the routed app imports them from here — the
 * room view mounts both itself.
 */
export { RoomThreadPanel } from './ui/RoomThreadPanel';
export { RoomThreadReplyRow } from './ui/RoomThreadReplyRow';
