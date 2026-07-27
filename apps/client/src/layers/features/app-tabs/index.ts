/**
 * App tabs — the desktop app's in-window tab strip (DOR-540).
 *
 * **The desktop app is the whole audience** (DOR-568). A browser already has
 * tabs, and they are better tabs than these could ever be: bookmarkable one at
 * a time, brought back by the browser's own session restore, draggable out into
 * their own window. Shipping a second strip there stacked one tab bar under
 * another and made the worse one ours. So the shell renders the strip, the
 * shortcuts register, and the link seam opens into it — in the desktop app only;
 * in a browser `target: 'tab'` opens a real browser tab, and the Obsidian embed
 * is one pane where everything opens in place.
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
export { APP_TAB_PANEL_ID } from './ui/AppTabItem';
export { useAppTabsSync } from './model/use-app-tabs-sync';
export { useAppTabShortcuts } from './model/use-app-tab-shortcuts';
export { useAppTabActions, NEW_TAB_HREF, type AppTabActions } from './model/use-app-tab-actions';
export { openTabAt, goToActiveTab, type TabRouter } from './model/tab-navigation';
export { parseTabHref, fallbackTabLabel, projectName, type TabTarget } from './lib/tab-target';
