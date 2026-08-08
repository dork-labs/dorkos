/** Which tab of the home surface is showing. */
export type HomeTabId = 'home' | 'activity' | 'scheduled' | 'workspaces';

/** One tab of the home surface: what it is called and where it goes. */
export interface HomeTab {
  /** Stable id, used for the active-state comparison and React keys. */
  id: HomeTabId;
  /** What the tab says. */
  label: string;
  /** The route the tab navigates to — an existing path, never a new one. */
  path: '/' | '/activity' | '/tasks' | '/workspaces';
}

/**
 * The four surfaces of the home tab bar, in bar order.
 *
 * **Label and path are allowed to disagree, and here they do.** "Scheduled"
 * addresses `/tasks`: the word people use for a run that happens later is not
 * the word the route was named after, and a URL is a contract — renaming it
 * would break every bookmark, tour deep link and release note pointing at the
 * old address for a rename nobody can see. The label is what changes.
 */
export const HOME_TABS: readonly HomeTab[] = [
  { id: 'home', label: 'Home', path: '/' },
  { id: 'activity', label: 'Activity', path: '/activity' },
  { id: 'scheduled', label: 'Scheduled', path: '/tasks' },
  { id: 'workspaces', label: 'Workspaces', path: '/workspaces' },
];

/**
 * The spellings of one address that all mean the same page.
 *
 * The router serves more addresses than it stores: it matches case-insensitively
 * and tolerates a trailing slash, but it hands back `location.pathname` exactly
 * as it was typed — `/Activity/` renders the Activity page and reports
 * `"/Activity/"`. Matching that raw string against the tab table found nothing,
 * so a hand-typed or copied link landed on the right page with no tab lit.
 *
 * Trailing slashes go (all of them: `//` is the same address), then case. The
 * root survives, because stripping its only slash would leave an empty string.
 */
function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '').toLowerCase() || '/';
}

/**
 * Which tab a pathname belongs to, or `null` when it belongs to none.
 *
 * Matched on the pathname alone: search params never decide which tab reads
 * active, so `/activity?categories=session` lands on Activity with its filter
 * intact. The match is exact after normalization — `/` is the Home tab and
 * nothing else, because a prefix match would make Home active everywhere.
 *
 * @param pathname - The router's current pathname, however it was spelled.
 * @returns The active tab's id, or `null` for a path outside the home surface.
 */
export function resolveHomeTabId(pathname: string): HomeTabId | null {
  const normalized = normalizePathname(pathname);
  return HOME_TABS.find((tab) => tab.path === normalized)?.id ?? null;
}
