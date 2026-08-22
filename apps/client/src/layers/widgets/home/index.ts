/**
 * Home surface — the tabbed shell over Home, Activity, Scheduled and Workspaces.
 *
 * The layout wraps four routes that already existed and renames none of them:
 * the tab bar is how you reach them, not where they live. See
 * {@link HomeSurfaceLayout} for why that separation is load-bearing.
 *
 * @module widgets/home
 */
// The layout is all this slice owes the router now. The tab table moved down to
// `shared/config` when the tabs moved INTO the bar (phase H1): the bar is a
// widget of its own, and a widget may not import another widget, so the four
// names and the pathname resolver had to live somewhere both can reach.
export { HomeSurfaceLayout } from './ui/HomeSurfaceLayout';
// The pinned triage header, in two halves: the wired one the Home tab mounts,
// and the presentational one behind it, which is exported so the Dev Playground
// can draw states a real cockpit only reaches when something is wrong.
export { PinnedTriageHeader } from './ui/PinnedTriageHeader';
export type { PinnedTriageHeaderProps } from './ui/PinnedTriageHeader';
export { PinnedTriageHeaderView } from './ui/PinnedTriageHeaderView';
export type { PinnedTriageHeaderViewProps, TriagePresenceSlot } from './ui/PinnedTriageHeaderView';
// Day one and the quiet morning (spec D3.6), in the same two halves: the wired
// component the Home tab mounts, and the presentational one the playground can
// draw without a cockpit that happens to be idle.
export { RoomStarterChips } from './ui/RoomStarterChips';
export type { RoomStarterChipsProps } from './ui/RoomStarterChips';
export { HOME_STARTER_CHIPS } from './lib/starter-chips';
export { HomeQuietState } from './ui/HomeQuietState';
export type { HomeQuietStateProps } from './ui/HomeQuietState';
export { QuietStateLine } from './ui/QuietStateLine';
export type { QuietStateLineProps } from './ui/QuietStateLine';
// The day's first look at Home, settling in.
export { FirstOpenSettle } from './ui/FirstOpenSettle';
