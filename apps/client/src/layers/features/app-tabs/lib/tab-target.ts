import {
  Activity,
  Cable,
  FolderGit2,
  Inbox,
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  MessagesSquare,
  Store,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * What a tab's href points at, and what to call it.
 *
 * A tab stores nothing but a location, so everything a person sees on it —
 * the name, the icon, the live badge — is derived from that string. Keeping the
 * derivation here as pure functions means the strip can be tested without a
 * router, and the label rules stay in one readable place. `ROUTE_LABELS` and
 * `ROUTE_ICONS` live side by side for the same reason: each missed `/channels`
 * once (DOR-587), then `ROUTE_ICONS` missed two more routes (DOR-919), all
 * while living in separate files, and a route-map drift
 * guard (`../__tests__/tab-target.test.ts`) checks both against the real router
 * now that they can't drift apart just by being edited in different places.
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
 *
 * @internal Exported for the route-map drift guard only.
 */
export const ROUTE_LABELS: Record<string, string> = {
  '/': 'Home',
  '/activity': 'Activity',
  '/team': 'Team',
  // The alias, labelled for where it lands rather than for its own spelling: a
  // tab persisted before the rename still restores as `/agents`, and reading
  // "Agents" on a strip whose page says Team is a tab that looks stale.
  '/agents': 'Team',
  '/channels': 'Channels',
  '/connections': 'Connections',
  '/feedback-requests': 'Product feedback',
  '/marketplace': 'Marketplace',
  '/marketplace/sources': 'Marketplace sources',
  '/tasks': 'Tasks',
  '/workspaces': 'Workspaces',
};

/**
 * Icon per route. A chat tab uses its agent's emoji when one is known, so
 * `/session` gets a real entry here (unlike {@link ROUTE_LABELS}) only as the
 * fallback shown before that emoji resolves.
 *
 * @internal Exported for the route-map drift guard only.
 */
export const ROUTE_ICONS: Record<string, LucideIcon> = {
  '/': LayoutDashboard,
  '/activity': Activity,
  // Same icon the sidebar nav uses for Team, and the alias gets it too.
  '/team': Users,
  '/agents': Users,
  // Plural on purpose: /session's single-bubble icon is taken, and two tabs
  // that read alike should at least not look alike (DOR-587 review).
  '/channels': MessagesSquare,
  // Same icon the sidebar nav and the /connections page already use for this
  // route (DOR-919).
  '/connections': Cable,
  // Same icon the help menu's "Product feedback" entry already uses
  // (DOR-919).
  '/feedback-requests': Inbox,
  '/marketplace': Store,
  '/marketplace/sources': Store,
  '/session': MessageSquare,
  '/tasks': ListTodo,
  '/workspaces': FolderGit2,
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
