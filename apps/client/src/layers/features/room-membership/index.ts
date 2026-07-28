/**
 * Room membership — who is in a channel or a direct message, and how they got
 * there.
 *
 * One slice rather than a corner of the sidebar, because the surfaces here are
 * reached from three places that are not the sidebar: the open room's header,
 * its empty state, and the sidebar row's menu (spec `rooms` §14.3). A shared
 * panel that lived inside one of its callers would make the other two import
 * the sidebar to open it.
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
 * @module features/room-membership
 */
export { AgentChipPicker } from './ui/AgentChipPicker';
export { AgentRosterPicker } from './ui/AgentRosterPicker';
export { ChannelCreateDialog } from './ui/ChannelCreateDialog';
export { NewDirectMessageMenu } from './ui/NewDirectMessageMenu';
export { RoomMembersDialog } from './ui/RoomMembersDialog';
export type { MembersDialogIntent, MembersDialogRoom } from './ui/RoomMembersDialog';
export { useAgentPickerCandidates } from './model/use-agent-picker-candidates';
