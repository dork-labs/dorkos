/**
 * Dashboard sidebar feature — Heads up, Today and Library, drawn from one pure
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
export { SidebarFooterStrip, useAskDorkBot } from './ui/SidebarFooterStrip';
// The panel's one bottom card — arbitrated, pinned above the footer, and
// mounted by the phone cockpit's Home panel too (spec `sidebar-simplification`
// D4).
export { SidebarBottomSlot } from './ui/bottom-slot/SidebarBottomSlot';
export { UpdatePill } from './ui/bottom-slot/UpdatePill';
export type { UpdatePillProps } from './ui/bottom-slot/UpdatePill';
export { useUpdateReady } from './ui/bottom-slot/use-update-ready';
export type { UpdateReadiness } from './ui/bottom-slot/use-update-ready';
// ── The panel, in parts, for the mobile tabs (P4) ──
// A phone splits one sidebar across two destinations, so the widget assembles
// the state once, builds the model once, and draws two subsets of the same
// zones. That is why the model lives in this feature rather than a slice of its
// own: a widget may import a feature, and drawing the same build twice is what
// keeps Home and Library from disagreeing (spec §A1, P4).
export { SidebarChrome } from './ui/SidebarChrome';
export { SidebarZones } from './ui/SidebarZones';
export { useSidebarState } from './model/use-sidebar-state';
export { useSidebarModel } from './model/use-sidebar-model';
// The boot skeleton and the one reveal's numbers, for the Dev Playground's
// "Sidebar Boot" page — which shows the REAL bones rather than a lookalike, so
// a geometry regression shows up there too (spec `sidebar-simplification` D6).
export { SidebarSkeleton } from './ui/boot/SidebarSkeleton';
export { REVEAL_CONTAINER, REVEAL_ZONE, revealTransition } from './ui/boot/sidebar-reveal';
// One-time migration of pre-redesign pins. `DashboardSidebar` runs it, and on a
// phone `DashboardSidebar` is never mounted — so the tabs run it instead, or an
// operator who only ever opens DorkOS on their phone keeps their old pins
// forever.
export { useLegacyPinMigration } from './model/use-legacy-pin-migration';
// BC-11's debounce, for the one surface that has to announce Now's count from
// OUTSIDE the zone: the phone's bottom bar. Its panels are `inert` whenever
// they are put away, so the region inside the zone is out of the accessibility
// tree exactly when the count matters, and the badge on the bar would otherwise
// be a number nobody ever hears. One hook, so the bar's announcement is held
// for the same second the panel's is.
export { useLiveRegionText } from './model/use-live-region-text';
// The zone enumeration and one zone's id — what the mobile tabs need to split
// the panel across two destinations. `SidebarModel` and `SidebarZoneModel` are
// deliberately NOT here: nothing outside the feature names them, and knip says
// so.
// `needsYouLiveRegionText` travels with them: the phone announces Heads up's
// count from beside its tab bar, and that count can outlive the zone it is
// normally read off — see the fallback in `MobileTabsLayout` (DOR-1391).
export {
  needsYouLiveRegionText,
  SIDEBAR_ZONE_IDS,
  type SidebarZoneId,
} from './model/build-sidebar-model';
export { AgentListItem } from './ui/AgentListItem';
// Where an agent's depth lives (BC-35). Exported because the command palette
// renders it too — a sibling feature composing this one's UI, which is the one
// cross-feature import the layer rules allow.
export { SessionSwitcher } from './ui/SessionSwitcher';
export { AgentActivityBadge } from './ui/AgentActivityBadge';
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
