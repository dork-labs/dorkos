import { HOME_SURFACE_PATHS, normalizePathname, type HomeSurfacePath } from './home-surface';

/** Which tab of the home surface is showing. */
export type HomeTabId = 'home' | 'activity' | 'scheduled' | 'workspaces';

/** One tab of the home surface: what it is called and where it goes. */
export interface HomeTab {
  /** Stable id, used for the active-state comparison and React keys. */
  id: HomeTabId;
  /** What the tab says. */
  label: string;
  /** The route the tab navigates to — an existing path, never a new one. */
  path: HomeSurfacePath;
}

/**
 * What each home route is called, in the bar.
 *
 * **Label and path are allowed to disagree, and here they do.** "Schedules"
 * addresses `/tasks`: the word people use for a run that happens later is not
 * the word the route was named after, and a URL is a contract — renaming it
 * would break every bookmark, tour deep link and release note pointing at the
 * old address for a rename nobody can see. The label is what changes.
 */
const TAB_NAMES: Record<HomeSurfacePath, { id: HomeTabId; label: string }> = {
  '/': { id: 'home', label: 'Home' },
  '/activity': { id: 'activity', label: 'Activity' },
  '/tasks': { id: 'scheduled', label: 'Schedules' },
  '/workspaces': { id: 'workspaces', label: 'Workspaces' },
};

/**
 * The tabs of the home tab bar, in bar order.
 *
 * Derived from `HOME_SURFACE_PATHS` rather than listed a second time, because
 * the sidebar keeps Home lit from that same list. Adding a route to the home
 * surface without naming it here is a compile error, so the bar can never be
 * missing a tab for a page the sidebar already calls Home.
 */
export const HOME_TABS: readonly HomeTab[] = HOME_SURFACE_PATHS.map((path) => ({
  ...TAB_NAMES[path],
  path,
}));

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
