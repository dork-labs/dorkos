/**
 * Which view the `/team` route is showing.
 *
 * Lives in `shared/` because four layers need the same answer and none of them
 * owns it: the route validates it, the shell picks a header from it, the header
 * draws the switch, and the page branches on it. A copy in any one of those
 * would be the copy that forgets a view.
 *
 * @module shared/lib/team-view
 */

/** The views `/team` serves, in the order the switch reads them. */
export const TEAM_VIEWS = ['cards', 'table', 'topology', 'denied', 'access'] as const;

/** One of {@link TEAM_VIEWS}. */
export type TeamViewMode = (typeof TEAM_VIEWS)[number];

/** What `/team` shows when nobody has chosen. */
export const DEFAULT_TEAM_VIEW: TeamViewMode = 'cards';

/**
 * `/agents`' old name for the table.
 *
 * Kept because `?view=list` is a live external address — the media-capture
 * pipeline opens it by hand (`apps/e2e/capture/surfaces-desktop.ts`), and so do
 * bookmarks and old release notes. It normalizes rather than 404s.
 */
export const LEGACY_TABLE_VIEW = 'list';

/**
 * Read a `?view=` value into a view this route serves.
 *
 * `'list'` becomes `'table'`; anything else unrecognised becomes the default,
 * because a view switch that renders nothing is worse than one that renders the
 * roster.
 *
 * @param value - The raw search-param value, from a URL nobody validated.
 */
export function normalizeTeamView(value: unknown): TeamViewMode {
  if (value === LEGACY_TABLE_VIEW) return 'table';
  return TEAM_VIEWS.includes(value as TeamViewMode) ? (value as TeamViewMode) : DEFAULT_TEAM_VIEW;
}
