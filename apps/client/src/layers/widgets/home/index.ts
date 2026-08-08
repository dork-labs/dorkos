/**
 * Home surface — the tabbed shell over Home, Activity, Scheduled and Workspaces.
 *
 * The layout wraps four routes that already existed and renames none of them:
 * the tab bar is how you reach them, not where they live. See
 * {@link HomeSurfaceLayout} for why that separation is load-bearing.
 *
 * @module widgets/home
 */
// Exactly what consumers outside this slice use today: the router mounts the
// layout, and the route-tree guard reads the tab table. `resolveHomeTabId` and
// the tab types stay internal until something outside needs them — the sidebar
// will, when Home's active state has to cover all four home paths, and it can
// export them then.
export { HomeSurfaceLayout } from './ui/HomeSurfaceLayout';
export { HOME_TABS } from './lib/home-tabs';
