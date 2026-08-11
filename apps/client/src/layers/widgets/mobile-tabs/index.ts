/**
 * The phone cockpit: four destinations along the bottom, and no drawer.
 *
 * `AppShell` picks between this and the desktop sidebar at one call site, so
 * reverting that one line restores the off-canvas sheet, which stays in
 * `shared/ui/sidebar.tsx` as the shared primitive it always was — the Dev
 * Playground and a dozen component tests mount it (spec §9, P4).
 *
 * **Not "for the Obsidian embed".** The task brief said so and three comments
 * here repeated it; the embed renders `EmbedSidebar`, which never touches
 * `<Sidebar>` or `SidebarProvider` at all. A justification nobody checks is
 * worse than none, because the next person plans around it.
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
// Whether a panel is covering the routed page. `AppShell` reads it to mark that
// page `inert` while it is covered — the modality the Radix Sheet used to
// provide for free, which four bottom destinations have to ask for.
export { useMobilePanelStore } from './model/mobile-panel-store';
