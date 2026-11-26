/**
 * The one header row every route gets, and the per-route bars that fill it.
 *
 * A widget rather than a feature because its route bars compose several
 * features each. The fixed cluster after the bar (search, the inbox bell, the
 * right-panel toggle) is the shell's: `src/app/header/BarFixedCluster.tsx`.
 *
 * @module widgets/one-bar
 */
export { OneBar, BarTitle } from './ui/OneBar';
export { TitleBar } from './ui/TitleBar';
export { ExtensionPageBar } from './ui/ExtensionPageBar';
// One bar for all four home surfaces — `/`, `/activity`, `/tasks` and
// `/workspaces` all declare THIS component, which is what keeps its tab strip
// mounted across a tab press (see `resolveRouteHeader`).
export { HomeSurfaceBar } from './ui/HomeSurfaceBar';
export { BarMembersChip } from './ui/BarMembersChip';
// Exported for the dev playground, which shows it beside the head count.
export { RoomLeadChip } from './ui/RoomLeadChip';
export { ChannelsBar } from './ui/ChannelsBar';
export { SessionHeader } from './ui/SessionHeader';
// What `/session` declares: the DM bar on an agent's Direct chat with the DM
// view on, else the session bar (DOR-3074).
export { SessionRouteHeader } from './ui/SessionRouteHeader';
export { TeamHeader, TEAM_VIEW_TABS } from './ui/TeamHeader';
// `useOneBarState` is deliberately NOT exported: the route bars that read it
// all live in this module, and the state it hands out is only meaningful to a
// component the shell has mounted inside the bar.
export { OneBarProvider } from './model/one-bar-context';
export type { OneBarRouteState } from './model/one-bar-context';
export { resolveRouteHeader } from './model/route-header';
export type { RouteHeader } from './model/route-header';
