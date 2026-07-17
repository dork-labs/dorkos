/**
 * Dashboard sidebar feature — top-level navigation plus the organized agent
 * roster (Recent sessions, Pinned references, user groups, ungrouped agents).
 *
 * Only symbols consumed outside the feature are exported here; the section
 * components, menus, and CRUD inputs are internal and imported by relative path.
 *
 * @module features/dashboard-sidebar
 */
export { DashboardSidebar } from './ui/DashboardSidebar';
export { AgentListItem } from './ui/AgentListItem';
export { AgentContextMenu } from './ui/AgentContextMenu';
export { AgentActivityBadge } from './ui/AgentActivityBadge';
export { AgentOnboardingCard } from './ui/AgentOnboardingCard';
