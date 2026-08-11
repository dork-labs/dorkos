/**
 * The phone cockpit: four destinations along the bottom, and no drawer.
 *
 * `AppShell` picks between this and the desktop sidebar at one call site, so
 * reverting that one line restores the off-canvas sheet — which stays in
 * `shared/ui/sidebar.tsx` regardless, because the Obsidian embed still uses it
 * (spec §9, P4).
 *
 * The destination list, the zone split and the bar's height are internal: they
 * are what this widget is made of, not what it offers, and the widget's own
 * tests import them by relative path like every other internal.
 *
 * @module widgets/mobile-tabs
 */
export { MobileTabsLayout } from './ui/MobileTabsLayout';
// The bar on its own, for the Dev Playground: it is the one pure piece of the
// phone cockpit, so it can be shown over every journey fixture in both themes
// with no server, no router and no clock.
export { MobileTabBar } from './ui/MobileTabBar';
export type { MobileTabId } from './model/mobile-tabs';
