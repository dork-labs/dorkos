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
 * it — **markdown links in chat and in `MarkdownContent` included**, since
 * DOR-547. `MarkdownLink` confirms a click and then hands the href to
 * {@link openExternalLink}, so there is one link policy in the product rather
 * than two that disagree (see {@link DISPATCHABLE_PROTOCOLS}).
 *
 * An internal link can land in three places, chosen by
 * {@link OpenLinkOptions.target}: in place (the default), in another tab, or in
 * a second cockpit window. `tab` and `window` stay separate on purpose —
 * "another tab" and "another window" are different requests, and the tab strip
 * must not quietly eat the only way to ask for the second one.
 *
 * **Who owns a tab depends on the surface** (DOR-568), and this module is what
 * decides. In the desktop app the cockpit owns its own strip and `tab` opens one
 * of those ({@link registerTabOpener}). In a browser the browser owns tabs, so
 * `tab` opens a real browser tab — bookmarkable, restored by session restore,
 * draggable into its own window, none of which ours could be. The Obsidian embed
 * is one pane, so a tab request lands in place.
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
 *   {@link DISPATCHABLE_PROTOCOLS}. Nothing opens, and the person is told why
 *   in one sentence rather than left watching a click do nothing. This matters
 *   because untrusted surfaces (gen-ui widgets, MCP App iframes, MCP
 *   elicitation, and every link an agent writes in chat) ask us to open links.
 *
 * The router is registered once from the app entry ({@link registerLinkNavigator}).
 * The Obsidian embed deliberately mounts no router, so internal dispatch there
 * warns and does nothing rather than crashing or forcing a document load that
 * would tear the embed pane down.
 *
 * @module shared/lib/link-navigation
 */
import { toast } from 'sonner';
import { getPlatform, isDesktopShell } from './platform';

/**
 * One toast slot for every refusal anywhere in the app. A second refused click
 * replaces the first message instead of stacking a near-identical one beside it.
 */
const REFUSAL_TOAST_ID = 'dorkos-link-refused';

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
  '/channels',
  '/connections',
  '/feedback-requests',
  '/marketplace',
  '/marketplace/sources',
  '/session',
  '/tasks',
  '/team',
  '/workspaces',
] as const;

const APP_ROUTE_SET: ReadonlySet<string> = new Set(APP_ROUTE_PATHS);

/**
 * Schemes the seam will dispatch from any surface. Everything else is refused
 * unless {@link isDispatchableProtocol} makes a surface-specific exception.
 *
 * An allowlist, not a denylist — and a strict tightening of what came before,
 * which permitted everything except `javascript:`, `data:` and `vbscript:`
 * (so `blob:`, `filesystem:`, `dorkos:` and `app:` all passed). This boundary
 * is fed by surfaces we do not control — gen-UI widgets an agent wrote, MCP App
 * iframes, MCP elicitation payloads — so it has to be safe against the scheme
 * nobody has thought of yet, not just the famous three.
 *
 * - `http:` / `https:` — nearly every link in the app.
 * - `mailto:` — kept dispatchable **on purpose**, reporting success. The line
 *   this list draws is "refuse what the current page's browser will refuse,
 *   allow what only the desktop shell currently declines". A browser hands
 *   `mailto:` to the OS mail client from any page, so on the web cockpit —
 *   the launch-critical surface — it genuinely goes somewhere. The desktop
 *   shell denies it today, but that is the shell's policy and it is being
 *   revised alongside this work; encoding a downstream gap here would be
 *   wrong, and nothing in the app links `mailto:` yet, so no reported outcome
 *   hangs on it.
 * - `tel:` — the same case as `mailto:`, added when markdown links joined this
 *   policy (DOR-547). A browser hands `tel:` to the OS dialer from any page,
 *   and the phone surface is a real one: an agent writing "call
 *   [support](tel:+15551234567)" produced a working link before this list
 *   governed markdown, and refusing it now would take that away for no safety
 *   gain — `tel:` carries no script and reaches nothing but the dialer, behind
 *   a confirmation the reader has to press. The desktop shell declines it, the
 *   same one-sided gap `mailto:` already documents, and declined it before
 *   this too: the raw `window.open` markdown used to dispatch hit the shell's
 *   http(s)-only window-open guard and did nothing. So no surface loses
 *   anything it had.
 *
 * Add a scheme only when something in the app actually opens one — and note
 * that this list is defense in depth, not the only defense: the desktop shell's
 * window-open handler is currently stricter still (`http(s)` only, everything
 * else denied outright).
 *
 * **This policy governs markdown links too, since DOR-547.** Streamdown's
 * `rehype-sanitize` pass still runs first and strips
 * `javascript:`/`data:`/`file:`/`vbscript:`/`blob:` hrefs before an anchor is
 * ever rendered; what it permits and this list does not — `irc:`, `ircs:`,
 * `xmpp:` — is now refused here, out loud, at dispatch. Two link policies that
 * disagreed became one.
 *
 * Full write-up, including the desktop shell's stricter layer on top of this
 * one: `contributing/link-dispatch-policy.md`.
 */
const DISPATCHABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Whether this scheme can be dispatched from a page at `base`.
 *
 * `file:` is the one surface-dependent case. It is retained for a single
 * reason: the `electron-vite preview` fallback loads the renderer straight off
 * disk (`window-manager.ts`), and there every relative in-app link inherits
 * `file:` — refusing it would break internal navigation in that mode. That
 * reason only applies *on* a `file:` page, so that is exactly where it is
 * allowed.
 *
 * From the `http:` cockpit a `file:` target is refused, because opening one is
 * a guaranteed no-op: browsers block `file:` from an `http:` page, and the
 * desktop shell forwards only `http(s)` — through its link guards and through
 * the `openExternal` bridge alike. Reporting success for a guaranteed no-op is
 * how "nothing opened" becomes "you're authorized" — see the return contract on
 * {@link openExternalLink}.
 *
 * @param protocol - The target's scheme, including the colon.
 * @param base - The page the link is being opened from.
 */
function isDispatchableProtocol(protocol: string, base: URL): boolean {
  if (DISPATCHABLE_PROTOCOLS.has(protocol)) return true;
  return protocol === 'file:' && base.protocol === 'file:';
}

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

  if (!isDispatchableProtocol(url.protocol, base)) {
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

/** The in-window tab adapter the seam drives for `target: 'tab'` (DOR-540). */
export type TabOpener = (href: string) => void;

let linkNavigator: LinkNavigator | null = null;
let tabOpener: TabOpener | null = null;

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
 * Register the in-window tab strip that `target: 'tab'` links open into. Called
 * once from the app entry, alongside {@link registerLinkNavigator}.
 *
 * Registered only where a tab strip actually exists — **the desktop shell**
 * (DOR-568). In a browser nothing registers, and {@link openLink} opens a real
 * browser tab instead, which is the better tab in every way that matters. The
 * Obsidian embed is one pane inside someone else's app, so a tab request there
 * lands in place.
 *
 * Registering is not what makes a tab an in-window one — {@link openLink} asks
 * {@link isDesktopShell} as well, so an opener left in scope on the wrong
 * surface is ignored rather than obeyed. The app entry's own gate is a
 * clarification of that rule, not the enforcement of it.
 *
 * @param open - Adapter that adds a tab for `href` and focuses it.
 * @returns An unregister function (idempotent; only clears its own adapter).
 */
export function registerTabOpener(open: TabOpener): () => void {
  tabOpener = open;
  return () => {
    if (tabOpener === open) tabOpener = null;
  };
}

/**
 * Whether this surface can show the cockpit somewhere other than in place.
 *
 * False in the Obsidian embed, which is one pane inside someone else's app —
 * and true everywhere else, which is what it has always meant. "A new tab" is
 * meaningful on the desktop and in a browser alike; only the owner of the tab
 * differs (see {@link registerTabOpener}).
 */
export function supportsNewTab(): boolean {
  return typeof window !== 'undefined' && !getPlatform().isEmbedded;
}

/**
 * Whether this surface can put the cockpit in a **separate window** — a real
 * second window, not another tab. The gate for offering "Open in New Window".
 *
 * Desktop only, and deliberately so. In the shell a same-origin `window.open`
 * is recognised by `setWindowOpenHandler` and built as a proper second cockpit
 * window, so the promise is kept. In a browser it is not a distinct destination
 * at all: a plain `window.open` already yields a tab, which is exactly what
 * "Open in New Tab" offers, and forcing a real window would take a
 * features-string popup — no address bar, no reload, no bookmark, worse than
 * the tab a person can drag out themselves in one gesture. Two menu items that
 * do the same thing is a lie told in the UI, so the browser is offered one.
 *
 * Composed of both halves on purpose. The embed has no bridge, so
 * {@link isDesktopShell} alone would already answer `false` there — naming
 * {@link supportsNewTab} as well is what records that "one pane inside someone
 * else's app" and "the browser owns windows here" are two different reasons for
 * the same answer, and that losing either one is not a simplification.
 */
export function supportsSeparateWindow(): boolean {
  return supportsNewTab() && isDesktopShell();
}

/**
 * The scheme an href names **for itself**, or `null` if it names none.
 *
 * Parsed with no base on purpose. A relative href (`/tasks`) inherits the
 * page's scheme when resolved, and in the Obsidian embed that is `app:` — so
 * resolving here would answer a refusal with "DorkOS doesn't open app: links",
 * naming a scheme the person never saw and cannot act on. Unresolved, the same
 * href simply has no scheme to name and gets the generic sentence instead.
 *
 * @param href - The refused link, exactly as the caller passed it.
 */
function declaredScheme(href: string): string | null {
  try {
    return new URL(href.trim()).protocol;
  } catch {
    return null;
  }
}

/**
 * Say out loud that a link was refused — one message shape, every surface.
 *
 * A refusal used to be a console warning and nothing else, so a click on an
 * `irc:` link in a chat answer did exactly what a click on a broken one did:
 * nothing, with no way to tell which had happened (DOR-547). The seam owns the
 * policy, so it owns the sentence too; a per-surface copy of this message would
 * drift from the allowlist the first time the allowlist moved.
 *
 * One `id` for every refusal, so clicking a second bad link replaces the toast
 * rather than stacking another.
 *
 * @param href - The refused link.
 * @param reason - Why {@link classifyLink} refused it.
 */
function reportRefusal(href: string, reason: BlockedLinkReason): void {
  console.warn(`[dorkos:link] refused to open ${reason} link:`, href);
  if (reason === 'unparsable') {
    toast.error("DorkOS couldn't open that link", {
      id: REFUSAL_TOAST_ID,
      description: 'That address is incomplete, so there is nowhere to send you.',
    });
    return;
  }
  const scheme = declaredScheme(href);
  toast.error(scheme ? `DorkOS doesn't open ${scheme} links` : "DorkOS couldn't open that link", {
    id: REFUSAL_TOAST_ID,
    description: 'Only web, email and phone links open from here.',
  });
}

/**
 * Hand a URL to the browser: a new tab on the web, the system browser on desktop.
 *
 * The desktop shell gets its own bridge because `window.open` cannot keep the
 * promise there for one URL in particular — our own. At
 * `http://localhost:<port>` the window-open handler recognises its own origin
 * and builds a second cockpit window (`window-manager.ts`), which is right for
 * "open in a new tab" and wrong for every caller here, all of whom promised to
 * leave. `openExternal` goes straight to `shell.openExternal`, under the same
 * http(s)-only policy the shell's link guards apply.
 */
function openInBrowser(url: string): void {
  // Feature-detect the METHOD, not the bridge, matching every other consumer of
  // `electronAPI` (`use-desktop-updater.ts`, `api-base-url.ts`,
  // `use-electron-navigate.ts`). A host that exposes a partial bridge would
  // otherwise throw out of here instead of falling back to `window.open`.
  const openExternal = typeof window === 'undefined' ? undefined : window.electronAPI?.openExternal;
  if (openExternal) {
    // Unlike `window.open`'s null return, this one can actually report. The
    // caller has already been told `true`, so the only honest thing left is to
    // say so where a bug report can find it, rather than let it surface as an
    // unhandled rejection with no context.
    openExternal(url).catch((err: unknown) => {
      console.error('[dorkos:link] the desktop shell could not open', url, err);
    });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Where an internal link should land.
 *
 * - `here` (default) — navigate the current view through the router.
 * - `tab` — another tab, opened by whoever owns tabs on this surface: the
 *   cockpit's own strip in the desktop app ({@link registerTabOpener}), a real
 *   browser tab in a browser. Falls back to `here` in the Obsidian embed, the
 *   one surface with no second place to put anything.
 * - `window` — a second cockpit window. Deliberately kept distinct from `tab`:
 *   "put this on my other monitor" is a different request from "give me another
 *   tab", and collapsing the two would delete the only way to ask for it. Only
 *   worth offering where it is a distinct destination — see
 *   {@link supportsSeparateWindow}, which is the gate the UI asks.
 *
 * **Neither degrades to `here` except in the embed.** Where a surface cannot
 * honour `window` — a browser — the request becomes a browser tab, not an
 * in-place navigation. Both answers are wrong in the same direction, but only
 * one of them takes something away: someone who asked for a second view and got
 * a tab still has the view they started from, and someone who got an in-place
 * navigation has lost it. The embed is the exception because one pane has
 * nowhere else to put anything, and opening in place beats doing nothing.
 */
export type LinkTarget = 'here' | 'tab' | 'window';

/** How to open a link. */
export interface OpenLinkOptions {
  /** Where an internal target should land. Defaults to `here`. */
  target?: LinkTarget;
  /** Replace the current history entry instead of pushing one. Internal, `here` only. */
  replace?: boolean;
}

/**
 * Open a link the right way for wherever it points.
 *
 * Internal links navigate in place through the router, into another tab, or
 * into a second cockpit window, per {@link OpenLinkOptions.target}; external
 * links go to the browser; blocked links go nowhere. This is the default entry
 * point — reach for it unless the action's whole point is to leave the app,
 * which is {@link openExternalLink}.
 *
 * @param href - The link to open.
 * @param options - Target and history intent.
 * @returns `true` if the link was dispatched, `false` if it was refused or
 * there was no router to route it through. A refusal announces itself
 * ({@link reportRefusal}), so the person is never left watching a click do
 * nothing — but **still check this before telling them something happened**:
 * "we could not open that" and "you're signed in" are different sentences, and
 * a UI that reports success it did not verify is how one becomes the other.
 */
export function openLink(href: string, options: OpenLinkOptions = {}): boolean {
  const link = classifyLink(href);

  if (link.kind === 'blocked') {
    reportRefusal(href, link.reason);
    return false;
  }

  if (link.kind === 'external') {
    openInBrowser(link.url);
    return true;
  }

  // A second view goes to the best place this **surface** can put it, and the
  // surface is what decides — not whoever happened to register an adapter. A
  // browser with a stray tab opener in scope still has to open a browser tab; if
  // the only thing standing between it and an in-place navigation into a strip
  // nothing renders were the `if (isDesktopShell())` in `main.tsx`, deleting
  // that line — it reads as redundant — would cost someone the view they asked
  // to keep, silently.
  if (options.target === 'window' && supportsSeparateWindow()) {
    // Two arguments, never three: no `noopener`. The desktop shell's
    // `setWindowOpenHandler` (`apps/desktop/src/main/window-manager.ts`) runs
    // `isOwnOrigin` on the URL: our own origin is denied to Electron's popup
    // path and built as a proper second cockpit window instead, loaded at
    // exactly this URL with the same preload and the same guards; anything else
    // goes to the system browser. So what we owe that handler is a plain,
    // classifiable same-origin target, which is what `classifyLink` guarantees
    // before we get here — and `noopener` would forfeit it.
    //
    // Read the handler rather than trusting this comment — it is the authority,
    // and it is where this behavior can change without touching this file.
    window.open(link.url, '_blank');
    return true;
  }

  if (options.target === 'tab' || options.target === 'window') {
    // The desktop app owns its own strip, so this is one of its tabs.
    if (tabOpener && isDesktopShell()) {
      tabOpener(link.path);
      return true;
    }
    // No strip on this surface. In a browser the browser owns tabs, and
    // `_blank` at our own origin is a real one of those — bookmarkable, restored
    // by session restore, draggable into its own window, none of which ours
    // could be. Two other requests land here and are answered honestly rather
    // than exactly:
    //
    // - `window` in a browser, where a separate window is not a destination
    //   worth offering ({@link supportsSeparateWindow}). A tab is not the second
    //   window that was asked for, but it is a second view; replacing the one
    //   the person is reading would be strictly worse.
    // - `tab` on the desktop before anything registered a strip. The URL hits
    //   the shell's own-origin handler and comes back as a second cockpit
    //   window — again not what was asked for, and again not wrong.
    if (supportsNewTab()) {
      window.open(link.url, '_blank');
      return true;
    }
    // Only the embed reaches here: one pane inside someone else's app, with
    // nowhere else to put anything. Fall through and open in place.
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
 * The right call for any action that promises to leave. Its callers range from
 * first-party buttons to agent-fed surfaces (gen-UI widget `url` actions, the
 * MCP App iframe, elicitation prompts, touch chips in the embed); the full
 * surface list lives in `contributing/link-dispatch-policy.md` rather than
 * here, where a count would drift. Where a {@link LinkSafetyModal} confirms
 * first, that modal's contract is "this leaves what you are looking at", so a
 * target that happens to be one of our own routes must still leave, not
 * navigate the view out from under the reader. Works with no router registered, so it behaves
 * identically in the router-less Obsidian embed.
 *
 * **Markdown links come through here too** (DOR-547). `MarkdownLink` — the
 * anchor every Streamdown instance in the app renders, in chat and in static
 * `MarkdownContent` alike — confirms the click and then calls this, so an
 * agent-authored prose link clears exactly the gate a first-party button does.
 *
 * @param href - The link to hand to the browser.
 * @returns `true` if the link was handed to the browser, `false` if its scheme
 * is outside {@link DISPATCHABLE_PROTOCOLS} or it could not be parsed. A
 * refusal tells the person why on its own; callers that report an outcome of
 * their own must still gate it on this.
 */
export function openExternalLink(href: string): boolean {
  const link = classifyLink(href);
  if (link.kind === 'blocked') {
    reportRefusal(href, link.reason);
    return false;
  }
  openInBrowser(link.url);
  return true;
}
