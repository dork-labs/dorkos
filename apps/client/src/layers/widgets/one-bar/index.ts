/**
 * The one header row every route gets, and the per-route bars that fill it.
 *
 * A widget rather than a feature because the bar owns the fixed cluster, and
 * the inbox bell in that cluster composes three features of its own.
 *
 * @module widgets/one-bar
 */
export { OneBar, BarTitle, BarFixedCluster } from './ui/OneBar';
export { TitleBar } from './ui/TitleBar';
// One bar for all four home surfaces — `/`, `/activity`, `/tasks` and
// `/workspaces` all declare THIS component, which is what keeps its tab strip
// mounted across a tab press (see `resolveRouteHeader`).
export { HomeSurfaceBar } from './ui/HomeSurfaceBar';
export { BarMembersChip } from './ui/BarMembersChip';
// The room chips, shared by the channel bar and Home's — Home is a room too.
export { RoomMembersChip } from './ui/RoomMembersChip';
export { RoomRunState } from './ui/RoomRunState';
export { ChannelsBar } from './ui/ChannelsBar';
export { SessionHeader } from './ui/SessionHeader';
export { TeamHeader, TEAM_VIEW_TABS } from './ui/TeamHeader';
export { OneBarProvider, useOneBarState } from './model/one-bar-context';
export type { OneBarRouteState } from './model/one-bar-context';
export { resolveRouteHeader } from './model/route-header';
export type { RouteHeader } from './model/route-header';
