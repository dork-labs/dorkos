/**
 * Dashboard sidebar feature — top-level navigation plus the organized agent
 * roster (Jump back in, Pinned references, user groups, ungrouped agents).
 *
 * Only symbols consumed outside the feature are exported here; the section
 * components, menus, and CRUD inputs are internal and imported by relative path.
 *
 * @module features/dashboard-sidebar
 */
export { DashboardSidebar } from './ui/DashboardSidebar';
// The nav header on its own — exported for the tour-anchor guard, which mounts
// the sidebar chrome at both widths without the roster's data behind it.
export { SidebarNavHeader } from './ui/SidebarNavHeader';
export { AgentListItem } from './ui/AgentListItem';
export { AgentContextMenu } from './ui/AgentContextMenu';
export { AgentActivityBadge } from './ui/AgentActivityBadge';
export { AgentOnboardingCard } from './ui/AgentOnboardingCard';
export { GroupsHintCard } from './ui/GroupsHintCard';
export { GroupCreateInput } from './ui/GroupCreateInput';
// The section header and the item lists it renders — exported for the Dev
// Playground, which showcases the sibling agent-row menu the same way.
export { SidebarSectionHeader } from './ui/SidebarSectionHeader';
export {
  buildAgentsHeaderMenuNodes,
  buildChannelsHeaderMenuNodes,
} from './ui/SectionHeaderMenuItems';
// The two "Jump back in" rows — exported for the Dev Playground, which is where
// the three kinds of row can be seen side by side without a real fleet.
export { JumpBackInRoomRow, JumpBackInSessionRow } from './ui/JumpBackInRow';
