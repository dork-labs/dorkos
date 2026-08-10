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
// The header block: the team name and its menu, the one New button, and the ⌘K
// pill. Persistent chrome — `AppShell` mounts it OUTSIDE the `sidebar.body`
// swap region, so a marketplace takeover replaces the body and leaves the way
// to make things standing (BC-43 → BC-46, P2 AC-8).
export { SidebarHeaderBlock } from './ui/SidebarHeaderBlock';
// The ⌘N chord on its own, so the shortcut registry's gate
// (`shortcuts-registered.test.tsx`) can mount and fire it without standing up
// the whole menu around it.
export { useNewSessionShortcut } from './model/use-new-session-shortcut';
// The footer strip on its own. It is persistent chrome — `AppShell` mounts it
// OUTSIDE the `sidebar.body` swap region, so a marketplace takeover replaces
// the body and leaves the strip standing (spec R2, P2 AC-8). It is also the one
// nav implementation in the panel now: the four destinations moved here off the
// retired `SidebarNavHeader`, tour anchor and all, so the tour-anchor guard
// mounts THIS at both widths for the reason it always mounted that.
export { SidebarFooterStrip } from './ui/SidebarFooterStrip';
export { AgentListItem } from './ui/AgentListItem';
// Where an agent's depth lives (BC-35). Exported because the command palette
// renders it too — a sibling feature composing this one's UI, which is the one
// cross-feature import the layer rules allow.
export { SessionSwitcher, SWITCHER_ROW_SLOT } from './ui/SessionSwitcher';
export type { SessionSwitcherProps } from './ui/SessionSwitcher';
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
// The chrome menus as data, for the same reason: the playground shows the
// header block's menu at three rows and at six, and the New menu at both fleet
// sizes, without standing up a roster and a router behind them.
export { buildHeaderBlockMenuNodes } from './ui/header-block-menu';
export { buildNewMenuNodes, NewMenu } from './ui/NewMenu';
// The two halves of the header block, exported so the Dev Playground shows the
// REAL controls rather than a copy of their markup. A showcase that draws a
// lookalike cannot catch a regression in the thing it is named after.
export { SidebarSearchPill } from './ui/SidebarSearchPill';
export { useAgentRowMenuNodes } from './ui/AgentRowMenuItems';
