/**
 * Dashboard sidebar feature — the places your conversations live (channels and
 * direct messages) and the doors to the pages that hold the rest, drawn from
 * one pure model (`model/build-sidebar-model.ts`).
 *
 * Only symbols consumed outside the feature are exported here; the section
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
export { MobileCommunityContextSwitcher } from './ui/context/CommunityContextSwitcher';
// The ⌘N chord on its own, so the shortcut registry's gate
// (`shortcuts-registered.test.tsx`) can mount and fire it without standing up
// the whole menu around it.
export { useNewSessionShortcut } from './model/use-new-session-shortcut';
export { useSwitchContextShortcut } from './model/use-switch-context-shortcut';
// The footer strip on its own. It is persistent chrome — `AppShell` mounts it
// OUTSIDE the `sidebar.body` swap region, so a marketplace takeover replaces
// the body and leaves the strip standing (spec R2, P2 AC-8). It is also the one
// nav implementation in the panel now: the four destinations moved here off the
// retired `SidebarNavHeader`, tour anchor and all, so the tour-anchor guard
// mounts THIS at both widths for the reason it always mounted that.
export { SidebarFooterStrip, useAskDorkBot } from './ui/SidebarFooterStrip';
export { YouRows } from './ui/context/YouRows';
// The panel's one bottom card — arbitrated, held above the footer, and
// mounted by the phone cockpit's Home panel too (spec `sidebar-simplification`
// D4).
export { SidebarBottomSlot } from './ui/bottom-slot/SidebarBottomSlot';
export { UpdatePill } from './ui/bottom-slot/UpdatePill';
export type { UpdatePillProps } from './ui/bottom-slot/UpdatePill';
export { useUpdateReady } from './ui/bottom-slot/use-update-ready';
export type { UpdateReadiness } from './ui/bottom-slot/use-update-ready';
// ── The panel, in parts, for the mobile tabs (P4) ──
// A phone draws the same list on its Home tab, so the widget assembles the
// state once, builds the model once, and draws the same sections the desktop
// panel does. That is why the model lives in this feature rather than a slice
// of its own: a widget may import a feature (spec §A1, P4).
export { SidebarChrome } from './ui/SidebarChrome';
export { SidebarSections } from './ui/SidebarSections';
export { useSidebarState } from './model/use-sidebar-state';
export { useSidebarModel } from './model/use-sidebar-model';
// The boot skeleton and the one reveal's numbers, for the Dev Playground's
// "Sidebar Boot" page — which shows the REAL bones rather than a lookalike, so
// a geometry regression shows up there too (spec `sidebar-simplification` D6).
export { SidebarSkeleton } from './ui/boot/SidebarSkeleton';
export { REVEAL_CONTAINER, REVEAL_SECTION, revealTransition } from './ui/boot/sidebar-reveal';
// The continuity layer, for the Dev Playground's "Sidebar Motion" page. Four
// symbols and no loose constants: the page draws the SHIPPED fold body and the
// SHIPPED drag chip, and builds its rows' motion through the same builder the
// panel uses — so a retune moves the page rather than leaving a lookalike that
// quietly stays right (spec `sidebar-simplification` D5).
export { buildRowMotion, sectionLayoutKey } from './ui/motion/sidebar-motion';
export { SidebarFoldBody } from './ui/motion/SidebarFoldBody';
export { DragLiftChip } from './ui/motion/DragLiftChip';
export { useArrivedRows } from './ui/motion/use-arrived-rows';
// One-time migration of pre-redesign pins. `DashboardSidebar` runs it, and on a
// phone `DashboardSidebar` is never mounted — so the tabs run it instead, or an
// operator who only ever opens DorkOS on their phone keeps their old pins
// forever.
export { useLegacyPinMigration } from './model/use-legacy-pin-migration';
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
export { buildChannelsHeaderMenuNodes } from './ui/SectionHeaderMenuItems';
// The chrome menus as data, for the same reason: the playground shows the
// header block's menu at three rows and at six, and the New menu at both fleet
// sizes, without standing up a roster and a router behind them.
export {
  buildHeaderBlockIdentityNodes,
  buildHeaderBlockVersionNodes,
} from './ui/header-block-menu';
export { buildNewMenuNodes, NewMenu } from './ui/NewMenu';
// The two halves of the header block, exported so the Dev Playground shows the
// REAL controls rather than a copy of their markup. A showcase that draws a
// lookalike cannot catch a regression in the thing it is named after.
export { SidebarSearchPill } from './ui/SidebarSearchPill';
export { useAgentRowMenuNodes } from './ui/AgentRowMenuItems';
