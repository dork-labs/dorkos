/**
 * Team entity — the roster of every identity on this install, and the ways the
 * page reads it.
 *
 * An entity rather than part of the widget that renders it first: the roster is
 * a domain object, and the profile drawer, the account menu and the table view
 * all read the same rows (spec §W2.3).
 *
 * @module entities/team
 */
export { TEAM_ROSTER_KEY } from './api/query-keys';
export { useTeamRoster, type UseTeamRosterOptions } from './model/use-team-roster';
export {
  DEFAULT_TEAM_FILTERS,
  filterTeamMembers,
  findTeamOwner,
  groupTeamByOwner,
  teamMemberLabel,
} from './lib/team-roster-selectors';
export type {
  TeamGrouping,
  TeamKindFilter,
  TeamOwnerGroup,
  TeamRosterFilters,
} from './lib/team-roster-selectors';
