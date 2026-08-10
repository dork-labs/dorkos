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
// The footer strip on its own. It is persistent chrome — `AppShell` mounts it
// OUTSIDE the `sidebar.body` swap region, so a marketplace takeover replaces
// the body and leaves the strip standing (spec R2, P2 AC-8). It is also the one
// nav implementation in the panel now: the four destinations moved here off the
// retired `SidebarNavHeader`, tour anchor and all, so the tour-anchor guard
// mounts THIS at both widths for the reason it always mounted that.
export { SidebarFooterStrip } from './ui/SidebarFooterStrip';
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
