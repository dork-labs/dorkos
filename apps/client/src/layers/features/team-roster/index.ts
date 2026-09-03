/**
 * Team roster feature — the cards, the controls and the banner the `/team`
 * page is built from.
 *
 * Presentational and controlled: every component here is handed rows and a
 * filter object and hands back an intent. The widget owns the data and the
 * state, which is what lets the same components be driven by a route's search
 * params, by a test, and by the playground without any of them being a special
 * case.
 *
 * @module features/team-roster
 */
export { TeamMemberCard } from './ui/TeamMemberCard';
export type { TeamMemberCardProps } from './ui/TeamMemberCard';
export { TeamRosterGrid, TEAM_ROSTER_GRID } from './ui/TeamRosterGrid';
export type { TeamRosterGridProps } from './ui/TeamRosterGrid';
export { TeamRosterSkeleton } from './ui/TeamRosterSkeleton';
export { TeamRosterToolbar } from './ui/TeamRosterToolbar';
export type { TeamRosterToolbarProps } from './ui/TeamRosterToolbar';
export { TeamRosterWarnings } from './ui/TeamRosterWarnings';
export type { TeamRosterWarningsProps } from './ui/TeamRosterWarnings';
