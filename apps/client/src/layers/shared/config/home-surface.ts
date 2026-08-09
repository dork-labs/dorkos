/**
 * The addresses that make up the home surface, and how to compare one.
 *
 * Two layers need this answer and neither may import the other: the home widget
 * lights the tab you are on, and the sidebar feature keeps Home lit for all four
 * of them. Plain data and a pure function, so `shared` is where both can reach
 * it and the two can never drift into disagreeing about what "on Home" means.
 *
 * @module shared/config/home-surface
 */

/**
 * Every route the home surface covers, in tab-bar order.
 *
 * The paths are the ones these pages have always had. The home surface wrapped
 * them in a tab bar rather than moving them, because a URL is a contract and
 * every bookmark, deep link and release note pointing at `/activity` still has
 * to land on Activity.
 */
export const HOME_SURFACE_PATHS = ['/', '/activity', '/tasks', '/workspaces'] as const;

/** One of the home surface's four routes. */
export type HomeSurfacePath = (typeof HOME_SURFACE_PATHS)[number];

/**
 * One address reduced to the single spelling everything else compares against.
 *
 * The router serves more addresses than it stores: it matches case-insensitively
 * and tolerates a trailing slash, but it hands back `location.pathname` exactly
 * as it was typed — `/Activity/` renders the Activity page and reports
 * `"/Activity/"`. Comparing that raw string against the table found nothing, so
 * a hand-typed or copied link landed on the right page with nothing lit.
 *
 * Trailing slashes go (all of them: `//` is the same address), then case. The
 * root survives, because stripping its only slash would leave an empty string.
 *
 * @param pathname - The router's current pathname, however it was spelled.
 * @returns The same address in its canonical spelling.
 */
export function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '').toLowerCase() || '/';
}

/**
 * Whether a pathname is anywhere on the home surface.
 *
 * @param pathname - The router's current pathname, however it was spelled.
 * @returns True for the four home routes, false for everywhere else.
 */
export function isHomeSurfacePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return HOME_SURFACE_PATHS.some((path) => path === normalized);
}
