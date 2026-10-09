/**
 * A tab href, taken apart into the parts the strip cares about.
 *
 * A tab stores nothing but a location, so everything a person sees on it is
 * derived from that string. Parsing lives here as a pure function so the strip
 * can be tested without a router; naming lives beside it in `tab-identity.ts`.
 *
 * @module features/app-tabs/lib/tab-target
 */

/** A tab href, taken apart into the parts the strip cares about. */
export interface TabTarget {
  /** Route path, e.g. `/session`. Always starts with `/`. */
  pathname: string;
  /** The `?session=` id for a chat tab, else `null`. */
  sessionId: string | null;
  /**
   * The `?dir=` project path for a chat tab, else `null`. A legacy hint only:
   * chat URLs have carried no `dir` since #2682, so a chat's real folder comes
   * from its route context or its session row (see `useTabIdentity`).
   */
  dir: string | null;
  /** Whether a chat tab's href is a draft (`?draft=1`): a chat with no row on the server yet. */
  draft: boolean;
  /** The `?id=` room id for a channel tab, else `null`. */
  roomId: string | null;
  /**
   * The `?community=` connection ref for a channel tab in a connected
   * community, else `null`. Its room id is that community's, not a local
   * room's, so the room has to be read through the community.
   */
  community: string | null;
  /**
   * The `?settings=` tab when the Settings dialog is open over the page, else
   * `null`. Any route can carry it.
   */
  settings: string | null;
  /**
   * The `?profile=` roster id when a profile is open over the page, else
   * `null`. Any route can carry it.
   */
  profile: string | null;
  /** The Marketplace search box (`?q=`), else `null`. */
  query: string | null;
  /** The Marketplace package open in its detail sheet (`?pkg=`), else `null`. */
  pkg: string | null;
}

/** Absolute base used only to make relative hrefs parseable. Never navigated to. */
const PARSE_BASE = 'http://tab.local';

/**
 * Take a tab href apart. Never throws — an unparseable href degrades to the
 * dashboard, which is the one route that is always safe to show.
 *
 * @param href - Router-relative location, e.g. `/session?session=abc&dir=%2Ftmp`.
 */
export function parseTabHref(href: string): TabTarget {
  const blank: TabTarget = {
    pathname: '/',
    sessionId: null,
    dir: null,
    draft: false,
    roomId: null,
    community: null,
    settings: null,
    profile: null,
    query: null,
    pkg: null,
  };
  let url: URL;
  try {
    url = new URL(href, PARSE_BASE);
  } catch {
    return blank;
  }
  const params = url.searchParams;
  const read = (key: string) => params.get(key) || null;
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : '/';
  // The overlays sit over any route; the rest belong to one route each.
  const target: TabTarget = {
    ...blank,
    pathname,
    settings: read('settings'),
    profile: read('profile'),
  };
  if (pathname === '/session') {
    return {
      ...target,
      sessionId: read('session'),
      dir: read('dir'),
      draft: params.get('draft') === '1',
    };
  }
  if (pathname === '/channels') {
    return { ...target, roomId: read('id'), community: read('community') };
  }
  if (pathname.startsWith('/marketplace')) {
    return { ...target, query: read('q'), pkg: read('pkg') };
  }
  return target;
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
