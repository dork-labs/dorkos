/**
 * App tabs — the desktop app's in-window tab strip (DOR-540).
 *
 * Within the desktop app, tabs live in this one renderer rather than a view per
 * tab: every tab points at the same trusted local origin, so a process each
 * would buy isolation we do not need and pay for it in memory and duplicated
 * app state.
 *
 * The tab list itself is `shared/model/app-tabs-store` — reachable from the
 * link seam and the command palette without either depending on this UI.
 *
 * @module features/app-tabs
 */
export { AppTabBar } from './ui/AppTabBar';
export { AppTabStrip } from './ui/AppTabStrip';
export type { AppTabMenuActions } from './ui/AppTabContextMenu';
export { APP_TAB_PANEL_ID, AppTabItemView } from './ui/AppTabItem';
export { TabIdentityCard } from './ui/TabHoverCard';
export { TabHistoryControls } from './ui/TabHistoryControls';
export { useAppTabsSync } from './model/use-app-tabs-sync';
export { useAppTabShortcuts } from './model/use-app-tab-shortcuts';
export { useTabHistoryShortcuts } from './model/use-tab-history-shortcuts';
export { useAppTabActions, NEW_TAB_HREF, type AppTabActions } from './model/use-app-tab-actions';
export { openTabAt, goToActiveTab, type TabRouter } from './model/tab-navigation';
export { parseTabHref, projectName, type TabTarget } from './lib/tab-target';
// One identity per page, read by the strip, the History menu and the window
// title alike (DOR-2820). The builders are exported for the Dev Playground,
// which lays out every route and status with the real component.
export { useTabIdentity } from './model/use-tab-identity';
export { useTabSignalsStore, useTabSignalsSync } from './model/tab-signals';
export {
  chatTabIdentity,
  roomTabIdentity,
  channelsTabIdentity,
  homeTabIdentity,
  teamTabIdentity,
  profileTabIdentity,
  settingsTabIdentity,
  marketplaceTabIdentity,
  extensionTabIdentity,
  routeTabIdentity,
  windowTitle,
  type RouteBadge,
  type TabIdentity,
  type TabStatus,
} from './lib/tab-identity';
