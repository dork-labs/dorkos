/**
 * Room management — making a channel or a direct message, and everything you
 * change about one afterwards: who is in it, and how each agent behaves there.
 *
 * One slice rather than a corner of the sidebar, because the surfaces here are
 * reached from three places that are not each other: the bar's members chip, an
 * empty room's offer to fill it, and the sidebar row's menu (spec `rooms` §14.3,
 * `one-bar-header` §3.6). A panel that lived inside one of its callers would
 * make the other two import that caller to open it.
 *
 * **Creating and managing stay in one slice**, even though they read as two
 * verbs. They share `AgentChipPicker` and `useAgentPickerCandidates`, and a
 * sibling feature may not import another feature's model — so splitting them
 * would force exactly the import the FSD rule forbids, or a second copy of the
 * fleet derivation, which is what `useAgentPickerCandidates` exists to
 * prevent.
 *
 * **Every surface here reads the fleet itself** rather than taking it as a
 * prop. That is what keeps `useAgentPickerCandidates` internal: the sidebar and
 * the open room both render these components, and neither has to hold — or
 * import — the roster to do it. Composing `entities/mesh` with
 * `entities/agent` is feature-layer work (an entity may not import a sibling
 * entity), so the hook cannot move down; keeping its only callers inside this
 * slice is what stops another feature importing it. UI composition across
 * features is allowed; model imports across features are not.
 *
 * @module features/room-management
 */
export { AgentChipPicker } from './ui/AgentChipPicker';
export { AgentRosterPicker } from './ui/AgentRosterPicker';
export { ChannelCreateDialog } from './ui/ChannelCreateDialog';
export { NewDirectMessageMenu } from './ui/NewDirectMessageMenu';
export { RoomPanel } from './ui/RoomPanel';
// The panel for a room somebody else has already resolved. `RoomPanel` is what
// the right-panel contribution mounts; this is the same surface with the route
// question answered, which is what the playground's fixtures need.
export { RoomPanelBody } from './ui/RoomPanelBody';
export { openRoomPanel, ROOM_PANEL_ID, useRoomPanelFocusStore } from './model/room-panel-focus';
export { routeShowsRoom } from './model/use-route-room';
// The fleet's faces, for the one surface outside this slice that draws a room's
// mark: the bar. Exported rather than re-derived there — see `use-room-faces`.
export { useRoomFaces, facesOfRoster } from './model/use-room-faces';
export { ONE_DOOR_HINT, oneDoorSubmitLabel, opensAgentSession } from './lib/one-door';
export type { RoomDetailsFocus, RoomDetailsRoom } from './model/room-details';
