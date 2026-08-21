/**
 * The one header row every route gets, and the per-route bars that fill it.
 *
 * A widget rather than a feature because the bar owns the fixed cluster, and
 * the inbox bell in that cluster composes three features of its own.
 *
 * @module widgets/one-bar
 */
export { OneBar, BarTitle } from './ui/OneBar';
export { TitleBar } from './ui/TitleBar';
export { DashboardHeader } from './ui/DashboardHeader';
export { ActivityHeader } from './ui/ActivityHeader';
export { TasksHeader } from './ui/TasksHeader';
export { ChannelsHeader } from './ui/ChannelsHeader';
export { SessionHeader } from './ui/SessionHeader';
export { TeamHeader } from './ui/TeamHeader';
export { OneBarProvider, useOneBarState } from './model/one-bar-context';
export type { OneBarRouteState } from './model/one-bar-context';
export { resolveRouteHeader } from './model/route-header';
export type { RouteHeader } from './model/route-header';
