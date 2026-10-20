/**
 * The DM view (DOR-3074): a chat with one agent drawn like a direct message,
 * over the agent's Direct chat session, behind the `ui.dmView` experiment.
 *
 * It decides how a chat is drawn (`useDirectMessageView`), moves between the DM
 * and the session behind it (`useSessionViewLinks`), says who the agent is and
 * which channels it shares with the person, and puts Message, Profile and the
 * agent's session on its identity card (`AgentHoverCard`). The surfaces that
 * draw a DM (the session widget, the one bar) compose these. The right panel
 * asks which DM it sits beside (`useDirectMessagePanel`), and a group DM's
 * panel is scoped to a member picked at its top (`GroupDmMemberPicker`).
 *
 * @module features/direct-message
 */
export {
  useDirectMessageView,
  useSessionViewLinks,
  type DirectMessageView,
  type SessionViewLinks,
} from './model/use-direct-message-view';
export {
  useDirectMessageAgent,
  useSharedChannels,
  useAgentStatusLine,
  type DirectMessageAgent,
} from './model/use-direct-message-agent';
export { useAgentCard, type AgentCard, type AgentCardInput } from './model/use-agent-card';
export { AgentHoverCard, type AgentHoverCardProps } from './ui/AgentHoverCard';
export { useDirectMessagePanel, type DirectMessagePanel } from './model/use-direct-message-panel';
export { GroupDmMemberPicker, type GroupDmMemberPickerProps } from './ui/GroupDmMemberPicker';
export { groupDmMembers, isGroupDm, type GroupDmMember } from './lib/group-dm';
export {
  directMessageMode,
  sharedChannels,
  splitSharedChannels,
  agentStatusLine,
  SHARED_CHANNELS_VISIBLE,
  type DirectMessageMode,
  type SharedChannel,
} from './lib/direct-message-rules';
