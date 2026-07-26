/**
 * Link seam — the single place that decides whether a link stays inside DorkOS
 * or leaves for the system browser, and dispatches it either way.
 *
 * Before this module every call site guessed. The command palette's "Open in
 * New Tab" built a URL from `window.location.href` and handed it to
 * `window.open`; in the packaged desktop app that is our own
 * `http://localhost:<port>` origin, so the shell's window-open guard — doing
 * exactly its job — sent the cockpit to Chrome. Classification now happens once,
 * here, and every navigation call site routes through it.
 *
 * - **Internal** — relative, hash-only, query-only, or absolute at the app's own
 *   origin *and* landing on a route the cockpit actually serves
 *   ({@link APP_ROUTE_PATHS}). Dispatched through TanStack Router, never as a
 *   document load: a full load in the desktop renderer remounts the whole SPA
 *   and drops streaming state.
 * - **External** — everything else: other origins, `mailto:`, custom schemes,
 *   and same-origin paths the router does not serve (`/api/…`, `/dev`).
 *   Dispatched with `window.open`, which is what the desktop shell's
 *   `will-navigate` / window-open guards watch for; they hand it to the system
 *   browser, which is the right home for it.
 * - **Blocked** — unparsable input and script-bearing schemes (`javascript:`,
 *   `data:`, `vbscript:`). Dispatch is a no-op. This matters because untrusted
 *   surfaces (gen-ui widgets, MCP App iframes) ask us to open links.
 *
 * The router is registered once from the app entry ({@link registerLinkNavigator}).
 * The Obsidian embed deliberately mounts no router, so internal dispatch there
 * warns and does nothing rather than crashing or forcing a document load that
 * would tear the embed pane down.
 *
 * @module shared/lib/link-navigation
 */
import { getPlatform } from './platform';

/**
 * Every path the cockpit's router serves — the definition of "internal".
 *
 * Kept here rather than derived from the router so classification stays a pure
 * function the tests can pin down. `app-route-paths.test.ts` builds the real
 * router and fails if the two ever drift.
 */
export const APP_ROUTE_PATHS = [
  '/',
  '/activity',
  '/agents',
  '/marketplace',
  '/marketplace/sources',
  '/session',
  '/tasks',
  '/workspaces',
] as const;

const APP_ROUTE_SET: ReadonlySet<string> = new Set(APP_ROUTE_PATHS);

/** Schemes that can execute code if opened. Never dispatched, however they arrive. */
const SCRIPT_BEARING_PROTOCOLS: ReadonlySet<string> = new Set([
  'javascript:',
  'data:',
  'vbscript:',
]);

/** Why the seam refused a link. */
export type BlockedLinkReason = 'unparsable' | 'unsafe-scheme';

/** A link that belongs to the cockpit and should be routed, not opened. */
export interface InternalLink {
  kind: 'internal';
  /** Fully-qualified URL at the app's own origin — what `window.open` needs. */
  url: string;
  /** Router-relative path + search + hash, e.g. `/session?dir=%2Ftmp`. */
  path: string;
}

/** A link that belongs outside the cockpit. */
export interface ExternalLink {
  kind: 'external';
  /** Fully-qualified URL to hand to the browser. */
  url: string;
}

/** A link the seam refuses to open. */
export interface BlockedLink {
  kind: 'blocked';
  reason: BlockedLinkReason;
}

/** The result of classifying a href. */
export type ClassifiedLink = InternalLink | ExternalLink | BlockedLink;

/** The current page URL, or a neutral origin when there is no document. */
function currentHref(): string {
  return typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
}

/** Drop a trailing slash so `/session/` matches the `/session` route. */
function normalizePathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
}

/**
 * Classify a href as internal, external, or blocked. Never throws.
 *
 * A query-only href (`?settings=open`) is a modifier on wherever you already
 * are — that is how the search-param dialog deep links are written — so its
 * params merge into the current search instead of replacing it, and it lands on
 * the current route. Every other form resolves exactly as a browser would
 * resolve an `<a href>`.
 *
 * @param href - The link to classify. Any shape, including malformed input.
 * @param from - Absolute URL to resolve against. Defaults to the current page.
 * @returns The classification, including the resolved URL when there is one.
 */
export function classifyLink(href: string, from: string = currentHref()): ClassifiedLink {
  const raw = typeof href === 'string' ? href.trim() : '';
  if (!raw) return { kind: 'blocked', reason: 'unparsable' };

  let base: URL;
  let url: URL;
  try {
    base = new URL(from);
    url = new URL(raw, base);
  } catch {
    return { kind: 'blocked', reason: 'unparsable' };
  }

  if (SCRIPT_BEARING_PROTOCOLS.has(url.protocol)) {
    return { kind: 'blocked', reason: 'unsafe-scheme' };
  }
  // Covers protocol-relative hrefs (`//evil.com`) and opaque schemes alike:
  // `mailto:`'s origin is the string "null", never our own.
  if (url.origin !== base.origin) return { kind: 'external', url: url.href };

  if (raw.startsWith('?')) {
    const merged = new URLSearchParams(base.search);
    new URLSearchParams(url.search).forEach((value, key) => merged.set(key, value));
    url.search = merged.toString();
  }

  const pathname = normalizePathname(url.pathname);
  if (!APP_ROUTE_SET.has(pathname)) return { kind: 'external', url: url.href };

  return { kind: 'internal', url: url.href, path: `${pathname}${url.search}${url.hash}` };
}

/** An internal navigation request handed to the router. */
export interface LinkNavigation {
  /** Router-relative path + search + hash, e.g. `/session?dir=%2Ftmp`. */
  href: string;
  /** Replace the current history entry instead of pushing one. */
  replace?: boolean;
}

/** The router adapter the seam drives for internal links. */
export type LinkNavigator = (navigation: LinkNavigation) => void;

let linkNavigator: LinkNavigator | null = null;

/**
 * Register the router that internal links navigate through. Called once from
 * the app entry, which owns the router instance.
 *
 * @param navigate - Adapter over the router's `navigate`.
 * @returns An unregister function (idempotent; only clears its own adapter).
 */
export function registerLinkNavigator(navigate: LinkNavigator): () => void {
  linkNavigator = navigate;
  return () => {
    if (linkNavigator === navigate) linkNavigator = null;
  };
}

/**
 * Whether this surface can open a second window onto the cockpit.
 *
 * False in the Obsidian embed, which is one pane inside someone else's app —
 * there is no second tab to open.
 */
export function supportsNewTab(): boolean {
  return typeof window !== 'undefined' && !getPlatform().isEmbedded;
}

/** Hand a URL to the browser: a new tab on the web, the system browser on desktop. */
function openInBrowser(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** How to open a link. */
export interface OpenLinkOptions {
  /**
   * Open an internal target in a second cockpit window instead of navigating in
   * place. Ignored where no second window exists (see {@link supportsNewTab}).
   */
  newTab?: boolean;
  /** Replace the current history entry instead of pushing one. Internal, same-window only. */
  replace?: boolean;
}

/**
 * Open a link the right way for wherever it points.
 *
 * Internal links navigate in place through the router (or into a second cockpit
 * window with `newTab`); external links go to the browser; blocked links go
 * nowhere. This is the default entry point — reach for it unless the action's
 * whole point is to leave the app, which is {@link openExternalLink}.
 *
 * @param href - The link to open.
 * @param options - New-window and history intent.
 */
export function openLink(href: string, options: OpenLinkOptions = {}): void {
  const link = classifyLink(href);

  if (link.kind === 'blocked') {
    console.warn(`[dorkos:link] refused to open ${link.reason} link:`, href);
    return;
  }

  if (link.kind === 'external') {
    openInBrowser(link.url);
    return;
  }

  if (options.newTab && supportsNewTab()) {
    // Plain `_blank`, no `noopener`: this is our own cockpit, and the desktop
    // shell's window-open handler turns it into a real DorkOS window.
    window.open(link.url, '_blank');
    return;
  }

  if (!linkNavigator) {
    // The embed has no router by design; anywhere else this means the app entry
    // never registered one. Falling back to a document load would reintroduce
    // the SPA remount this seam exists to prevent.
    console.warn('[dorkos:link] no router registered — ignoring internal link:', href);
    return;
  }

  linkNavigator({ href: link.path, replace: options.replace });
}

/**
 * Open a link outside the app, whatever it points at.
 *
 * The deliberate escape hatch for actions whose whole purpose is to leave —
 * the canvas browser's "Open in system browser" button — where the target may
 * well be one of our own URLs and routing it in-app would contradict the
 * button. Script-bearing schemes are still refused.
 *
 * @param href - The link to hand to the browser.
 */
export function openExternalLink(href: string): void {
  const link = classifyLink(href);
  if (link.kind === 'blocked') {
    console.warn(`[dorkos:link] refused to open ${link.reason} link:`, href);
    return;
  }
  openInBrowser(link.url);
}
