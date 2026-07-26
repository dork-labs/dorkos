/**
 * Link seam — the single place that decides whether a link stays inside DorkOS
 * or leaves for the system browser, and dispatches it either way.
 *
 * Before this module every call site guessed. The command palette's "Open in
 * New Tab" built a URL from `window.location.href` and handed it to
 * `window.open`; in the packaged desktop app that is our own
 * `http://localhost:<port>` origin, so the shell's window-open guard — doing
 * exactly its job — sends the cockpit to Chrome. Classification now happens
 * once, here, and every navigation the app's own code initiates routes through
 * it. **Markdown links do not**: Streamdown renders and dispatches those under
 * its own policy (see {@link DISPATCHABLE_PROTOCOLS}).
 *
 * What that fixes today is the in-place half: internal links move the router
 * instead of reloading the document. The new-tab half is not fixed yet — the
 * shell's handler (`apps/desktop/src/main/window-manager.ts`) reads only the
 * URL and still forwards any `http(s)` target to the system browser. Teaching
 * it to adopt our own origin as a DorkOS window is separate work; this module
 * keeps the call shape that lets it.
 *
 * - **Internal** — relative, hash-only, query-only, or absolute at the app's own
 *   origin *and* landing on a route the cockpit actually serves
 *   ({@link APP_ROUTE_PATHS}). Dispatched through TanStack Router, never as a
 *   document load: a full load in the desktop renderer remounts the whole SPA
 *   and drops streaming state.
 * - **External** — everything else: other origins, `mailto:`, and same-origin
 *   paths the router does not serve (`/api/…`, `/dev`). Dispatched with
 *   `window.open`, which is what the desktop shell's `will-navigate` /
 *   window-open guards watch for; they hand it to the system browser, which is
 *   the right home for it.
 * - **Blocked** — unparsable input, and any scheme outside
 *   {@link DISPATCHABLE_PROTOCOLS}. Dispatch is a no-op. This matters because
 *   untrusted surfaces (gen-ui widgets, MCP App iframes, MCP elicitation) ask
 *   us to open links.
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
 *
 * **Static paths only.** {@link classifyLink} matches a pathname by exact set
 * membership, so a parameterised route (`/session/$sessionId`) cannot be
 * represented by adding its literal here — the literal would satisfy the drift
 * guard while `/session/abc` classified as external and got handed to the
 * system browser. The guard rejects dynamic segments for that reason; a router
 * that grows one needs a real matcher here, not another entry.
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

/**
 * The only schemes the seam will dispatch. Everything else is refused.
 *
 * An allowlist, not a denylist — and a strict tightening of what came before,
 * which permitted everything except `javascript:`, `data:` and `vbscript:`
 * (so `blob:`, `filesystem:`, `dorkos:` and `app:` all passed). This boundary
 * is fed by surfaces we do not control — gen-UI widgets an agent wrote, MCP App
 * iframes, MCP elicitation payloads — so it has to be safe against the scheme
 * nobody has thought of yet, not just the famous three.
 *
 * - `http:` / `https:` — nearly every link in the app.
 * - `mailto:` — inert, and a link type people expect to work.
 * - `file:` — **retained, not added**, and only a dev-path needs it: the
 *   `electron-vite preview` fallback loads the renderer straight off disk
 *   (`window-manager.ts`), and there every relative in-app link inherits
 *   `file:`, so dropping it would break internal links in that mode. The
 *   packaged app serves the renderer over `http://localhost:<port>` instead.
 *   The canvas browser can also hold a `file://` target
 *   (`classifyBrowserTarget` accepts one), but opening it is already a no-op on
 *   every shipped surface — the desktop shell forwards only `http(s)` and
 *   exposes no `openExternal` bridge, and browsers refuse `file:` from an
 *   `http:` page. Dropping `file:` would turn that silent no-op into a warning,
 *   nothing more; the preview path is the real reason it stays.
 *
 * Add a scheme only when something in the app actually opens one — and note
 * that this list is defense in depth, not the only defense: the desktop shell's
 * window-open handler is currently stricter still (`http(s)` only, everything
 * else denied outright).
 *
 * **This policy does not govern markdown links.** Streamdown renders chat and
 * `MarkdownContent` anchors and dispatches them itself, under `rehype-harden`'s
 * sanitizer, which blocks `javascript:`/`data:`/`file:`/`vbscript:` but permits
 * `blob:`, `irc:` and `xmpp:` — schemes this list refuses. The two policies are
 * knowingly divergent; reconciling them is filed separately.
 */
const DISPATCHABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'mailto:',
  'file:',
]);

/** Why the seam refused a link. */
export type BlockedLinkReason = 'unparsable' | 'unsupported-scheme';

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

  if (!DISPATCHABLE_PROTOCOLS.has(url.protocol)) {
    return { kind: 'blocked', reason: 'unsupported-scheme' };
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
 * @returns `true` if the link was dispatched, `false` if it was refused or
 * there was no router to route it through. **Check this before telling the user
 * anything happened** — a refusal is silent otherwise, and a UI that reports
 * success it did not verify is how "nothing opened" becomes "you're signed in".
 */
export function openLink(href: string, options: OpenLinkOptions = {}): boolean {
  const link = classifyLink(href);

  if (link.kind === 'blocked') {
    console.warn(`[dorkos:link] refused to open ${link.reason} link:`, href);
    return false;
  }

  if (link.kind === 'external') {
    openInBrowser(link.url);
    return true;
  }

  if (options.newTab && supportsNewTab()) {
    // Plain `_blank`, no `noopener` — forward wiring. In the browser this is
    // already a real second cockpit tab. In the desktop shell it is still
    // forwarded to the system browser today: the window-open handler
    // (`apps/desktop/src/main/window-manager.ts`) reads only the URL and
    // ignores `features`/`disposition`. Keeping the shape unpolluted is what
    // lets that handler tell "our own cockpit" from "someone else's site" when
    // it grows the check; adding `noopener` here would foreclose it.
    window.open(link.url, '_blank');
    return true;
  }

  if (!linkNavigator) {
    // The embed has no router by design; anywhere else this means the app entry
    // never registered one. Falling back to a document load would reintroduce
    // the SPA remount this seam exists to prevent.
    console.warn('[dorkos:link] no router registered — ignoring internal link:', href);
    return false;
  }

  linkNavigator({ href: link.path, replace: options.replace });
  return true;
}

/**
 * Open a link outside the app, whatever it points at.
 *
 * The right call for any action that promises to leave. Its three direct call
 * sites are the canvas browser's "Open in system browser" button and the two
 * surfaces that render {@link LinkSafetyModal} themselves — the gen-UI widget
 * `url` action and the MCP App iframe — plus the MCP elicitation prompt. That
 * modal's contract is "this leaves what you are looking at", so a target that
 * happens to be one of our own routes must still leave, not navigate the view
 * out from under the reader. Works with no router registered, so it behaves
 * identically in the router-less Obsidian embed.
 *
 * **Not every link in the product comes through here.** Markdown links in chat
 * and in static `MarkdownContent` are rendered by Streamdown, which owns its own
 * anchor, its own confirm handler, and its own `window.open` — see the note on
 * {@link DISPATCHABLE_PROTOCOLS} about where the two policies diverge. Do not
 * read this module as covering agent-authored prose links.
 *
 * @param href - The link to hand to the browser.
 * @returns `true` if the link was handed to the browser, `false` if its scheme
 * is outside {@link DISPATCHABLE_PROTOCOLS} or it could not be parsed. Callers
 * that then report an outcome to the user must gate on this.
 */
export function openExternalLink(href: string): boolean {
  const link = classifyLink(href);
  if (link.kind === 'blocked') {
    console.warn(`[dorkos:link] refused to open ${link.reason} link:`, href);
    return false;
  }
  openInBrowser(link.url);
  return true;
}
