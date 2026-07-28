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
 * @module features/room-membership
 */
export { AgentChipPicker } from './ui/AgentChipPicker';
export { ChannelCreateDialog } from './ui/ChannelCreateDialog';
export { RoomMembersDialog } from './ui/RoomMembersDialog';
export type { MembersDialogIntent, MembersDialogRoom } from './ui/RoomMembersDialog';
export { useAgentPickerCandidates } from './model/use-agent-picker-candidates';
