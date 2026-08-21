import { Outlet } from '@tanstack/react-router';

/**
 * The home surface: four pages that are one place.
 *
 * Home, Activity, Scheduled and Workspaces used to be four sidebar
 * destinations. They are one surface now — but only in how they are reached.
 * This is a pathless layout route, so `/`, `/activity`, `/tasks` and
 * `/workspaces` keep their paths, their search schemas and their loaders
 * untouched, and every bookmark and deep link lands exactly where it did
 * before, tab and filters intact.
 *
 * **The tabs are not here any more (phase H1).** They used to be a row of their
 * own directly under the header, which made every home page two header rows
 * tall. They ride in the bar itself now (`HomeSurfaceBar`), which is also why
 * the active tab is no longer resolved here: the bar reads the pathname, so
 * whatever moved the URL — a tab, the command palette, the back button, a deep
 * link — the strip agrees with the address bar without this route holding any
 * state.
 *
 * What is left is the box the four pages are drawn in: a sized, clipped
 * container, so a page that scrolls owns its own scroller and one that does not
 * cannot push the shell around.
 */
export function HomeSurfaceLayout() {
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <Outlet />
    </div>
  );
}
