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
export { AgentActivityBadge } from './ui/AgentActivityBadge';
export { AgentOnboardingCard } from './ui/AgentOnboardingCard';
export { GroupsHintCard } from './ui/GroupsHintCard';
export { GroupCreateInput } from './ui/GroupCreateInput';
// The section-header menu builders — exported for the Dev Playground, which
// shows the shared `SectionHeader` primitive wearing a real section's items.
// The header itself is `shared/ui`'s now, and so is the row.
export {
  buildAgentsHeaderMenuNodes,
  buildChannelsHeaderMenuNodes,
} from './ui/SectionHeaderMenuItems';
export { useAgentRowMenuNodes } from './ui/AgentRowMenuItems';
