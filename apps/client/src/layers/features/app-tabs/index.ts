/**
 * App tabs — the cockpit's in-window tab strip (DOR-540).
 *
 * Tabs live in this one renderer rather than a view per tab: every tab points
 * at the same trusted local origin, so a process each would buy isolation we do
 * not need and pay for it in memory and duplicated app state. In exchange the
 * same feature ships to the browser cockpit, not just the desktop app.
 *
 * The tab list itself is `shared/model/app-tabs-store` — reachable from the
 * link seam and the command palette without either depending on this UI.
 *
 * @module features/app-tabs
 */
export { AppTabBar } from './ui/AppTabBar';
export { AppTabStrip } from './ui/AppTabStrip';
export { APP_TAB_PANEL_ID } from './ui/AppTabItem';
export { useAppTabsSync } from './model/use-app-tabs-sync';
export { useAppTabShortcuts } from './model/use-app-tab-shortcuts';
export { useAppTabActions, NEW_TAB_HREF, type AppTabActions } from './model/use-app-tab-actions';
export { openTabAt, goToActiveTab, type TabRouter } from './model/tab-navigation';
export { parseTabHref, fallbackTabLabel, projectName, type TabTarget } from './lib/tab-target';
