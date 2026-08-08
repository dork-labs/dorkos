import { Outlet, useRouterState } from '@tanstack/react-router';
import { resolveHomeTabId } from '../lib/home-tabs';
import { HomeTabBar } from './HomeTabBar';

/**
 * The home surface: one tab bar over four pages that already existed.
 *
 * Home, Activity, Scheduled and Workspaces used to be four sidebar
 * destinations. They are one place now — but only in how they are reached. This
 * is a pathless layout route, so `/`, `/activity`, `/tasks` and `/workspaces`
 * keep their paths, their search schemas and their loaders untouched, and every
 * bookmark and deep link lands exactly where it did before, tab and filters
 * intact.
 *
 * The active tab is read from the pathname on every render rather than held in
 * state, so there is nothing to keep in sync: whatever moved the URL — a tab, a
 * command palette entry, the back button, a deep link — the bar agrees with the
 * address bar.
 *
 * The page below scrolls; the bar does not.
 */
export function HomeSurfaceLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HomeTabBar activeTabId={resolveHomeTabId(pathname)} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
