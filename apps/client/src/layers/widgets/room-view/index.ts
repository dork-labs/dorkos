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
