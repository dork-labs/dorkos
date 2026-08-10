/**
 * Dashboard sidebar feature — Now, Today and Library, drawn from one pure
 * model (`model/build-sidebar-model.ts`).
 *
 * Only symbols consumed outside the feature are exported here; the zone
 * components, section chrome, menus and CRUD inputs are internal and imported
 * by relative path.
 *
 * @module features/dashboard-sidebar
 */
export { DashboardSidebar } from './ui/DashboardSidebar';
// The nav header on its own. It is persistent chrome now — `AppShell` mounts it
// OUTSIDE the `sidebar.body` swap region, so a marketplace takeover replaces
// the body and leaves the header standing (spec R2, P2 AC-8). The tour-anchor
// guard mounts it at both widths for the same reason it always did.
export { SidebarNavHeader } from './ui/SidebarNavHeader';
export { AgentListItem } from './ui/AgentListItem';
export { AgentActivityBadge } from './ui/AgentActivityBadge';
export { AgentOnboardingCard } from './ui/AgentOnboardingCard';
export { GroupCreateInput } from './ui/GroupCreateInput';
// The section-header menu builders — exported for the Dev Playground, which
// shows the shared `SectionHeader` primitive wearing a real section's items.
// The header itself is `shared/ui`'s now, and so is the row.
export {
  buildAgentsHeaderMenuNodes,
  buildChannelsHeaderMenuNodes,
} from './ui/SectionHeaderMenuItems';
export { useAgentRowMenuNodes } from './ui/AgentRowMenuItems';
