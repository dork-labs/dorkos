/**
 * What a tab's href points at, and what to call it.
 *
 * A tab stores nothing but a location, so everything a person sees on it —
 * the name, the icon, the live badge — is derived from that string. Keeping the
 * derivation here as pure functions means the strip can be tested without a
 * router, and the label rules stay in one readable place.
 *
 * @module features/app-tabs/lib/tab-target
 */

/** A tab href, taken apart into the parts the strip cares about. */
export interface TabTarget {
  /** Route path, e.g. `/session`. Always starts with `/`. */
  pathname: string;
  /** The `?session=` id for a chat tab, else `null`. */
  sessionId: string | null;
  /** The `?dir=` project path for a chat tab, else `null`. */
  dir: string | null;
}

/**
 * Every route the tab strip can name, and the name a person would use for it.
 * `/session` is absent on purpose: a chat tab is named after its agent, not
 * after the route.
 */
const ROUTE_LABELS: Record<string, string> = {
  '/': 'Dashboard',
  '/activity': 'Activity',
  '/agents': 'Agents',
  '/channels': 'Channels',
  '/connections': 'Connections',
  '/feedback-requests': 'Feedback & requests',
  '/marketplace': 'Marketplace',
  '/marketplace/sources': 'Marketplace sources',
  '/tasks': 'Tasks',
  '/workspaces': 'Workspaces',
};

/** Fallback name for a chat tab whose agent and project are both unknown. */
const SESSION_FALLBACK_LABEL = 'Session';

/** Fallback name for a route the strip has no word for (a future route, a typo). */
const UNKNOWN_ROUTE_LABEL = 'DorkOS';

/** Absolute base used only to make relative hrefs parseable. Never navigated to. */
const PARSE_BASE = 'http://tab.local';

/**
 * Take a tab href apart. Never throws — an unparseable href degrades to the
 * dashboard, which is the one route that is always safe to show.
 *
 * @param href - Router-relative location, e.g. `/session?session=abc&dir=%2Ftmp`.
 */
export function parseTabHref(href: string): TabTarget {
  let url: URL;
  try {
    url = new URL(href, PARSE_BASE);
  } catch {
    return { pathname: '/', sessionId: null, dir: null };
  }
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : '/';
  if (pathname !== '/session') return { pathname, sessionId: null, dir: null };
  return {
    pathname,
    sessionId: url.searchParams.get('session') || null,
    dir: url.searchParams.get('dir') || null,
  };
}

/**
 * The last segment of a project path — how people actually refer to a project
 * ("api", not "/Users/kai/code/api"). Returns `undefined` for a blank path.
 *
 * @param dir - Absolute project path, or `null`.
 */
export function projectName(dir: string | null): string | undefined {
  if (!dir) return undefined;
  const segments = dir.split('/').filter(Boolean);
  return segments[segments.length - 1];
}

/**
 * The name to show on a tab before any live agent data arrives — the route's
 * own name, or a chat tab's project folder. Every tab always has a name, so the
 * strip never renders a blank or a spinner where a word should be.
 *
 * @param target - The parsed href.
 */
export function fallbackTabLabel(target: TabTarget): string {
  if (target.pathname === '/session') {
    return projectName(target.dir) ?? SESSION_FALLBACK_LABEL;
  }
  return ROUTE_LABELS[target.pathname] ?? UNKNOWN_ROUTE_LABEL;
}
