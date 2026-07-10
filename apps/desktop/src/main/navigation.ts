import type { BrowserWindow } from 'electron';

/**
 * Client route the "Settings…" menu item opens.
 *
 * Settings is a modal dialog toggled by the `settings` search param, not a
 * routed page — see `apps/client/src/layers/shared/model/use-dialog-deep-link.ts`
 * (`useSettingsDeepLink`). The dialog deep-links from any route, so this
 * lands on the dashboard with the param set, which reliably opens it
 * regardless of what the renderer was last showing.
 */
export const SETTINGS_ROUTE = '/?settings=open';

/**
 * Send the `navigate` IPC message to a window's renderer, asking the client's
 * TanStack Router to route to `path` (see ADR 260709-210223). This is the
 * low-level delivery primitive: it always sends immediately over the wire,
 * with no regard for whether a listener is subscribed yet on the other end
 * — {@link requestNavigate} is the policy layer on top that decides whether
 * it's safe to call this directly, or whether to queue the path instead.
 *
 * A no-op when `win` is `null` or already destroyed — callers look up the
 * window at click-time (see `index.ts`'s `getMainWindow`), so this only
 * happens if the window closed between the click and the send.
 *
 * @param win - The window to navigate.
 * @param path - A client route path, optionally with a query string (e.g. `/agents`).
 */
export function sendNavigate(win: BrowserWindow | null, path: string): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('navigate', path);
}

/**
 * Parse a `dorkos://` deep link into a client route path.
 *
 * Maps `dorkos://<host>/<path>?<query>` to `/<host>/<path>?<query>`. Custom
 * schemes are not in the WHATWG "special scheme" list (unlike `http`/`https`),
 * but Chromium's URL parser still splits an authority out of anything
 * followed by `//` — so `dorkos://agents` parses with hostname `agents` and
 * an empty path, not host `""` with path `/agents`. That authority segment
 * becomes the first path segment of the mapped route, and the query string
 * is preserved verbatim.
 *
 * Examples: `dorkos://agents` → `/agents`; `dorkos://agents/123` →
 * `/agents/123`; `dorkos://session?id=x` → `/session?id=x`.
 *
 * Returns `null` for anything that isn't a well-formed `dorkos://` URL with
 * a non-empty host — wrong scheme, unparseable input, or a bare `dorkos://`
 * with no host — so the caller can fall back to "just focus the window".
 *
 * @param url - The raw URL string handed to Electron's `open-url` event.
 */
export function parseDeepLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'dorkos:' || !parsed.hostname) return null;

  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `/${parsed.hostname}${path}${parsed.search}`;
}

// --- Pending-navigation handoff (Chunk D carryover from Chunk B review) ---
//
// `sendNavigate` alone drops a path in two cases: a cold-start deep link
// (`open-url` firing before any window/renderer exists) and a menu click
// (Settings… on macOS) with zero windows open. Both need "deliver this path
// to whichever window ends up showing it, whenever its renderer is ready to
// receive it" — a single pending slot plus a renderer-readiness signal
// covers both with one mechanism (see `requestNavigate`/`resolvePendingNavigate`).

/** The most recently requested path that hasn't been delivered yet (last-write-wins). */
let pendingPath: string | null = null;

/**
 * The `webContents.id` of the renderer that most recently proved it's
 * subscribed and ready (by invoking `get-pending-navigate`). `id` is unique
 * per `WebContents` instance, so this naturally resets to "not ready" when
 * the tracked window is destroyed and recreated. It does NOT reset on a
 * reload or renderer crash — the `WebContents` (and its id) survives those
 * while the JS context dies — which is what {@link registerReadinessReset}
 * exists to handle.
 */
let readyWebContentsId: number | null = null;

/** Has `win`'s renderer signaled it's subscribed and ready to receive `navigate` events? */
function isRendererReady(win: BrowserWindow): boolean {
  return win.webContents.id === readyWebContentsId;
}

/**
 * Attach listeners that clear the readiness mark when `win`'s renderer JS
 * context is torn down without its `WebContents` being destroyed. Call once
 * per tracked window, right after creation.
 *
 * A reload (`Cmd+R`) or a renderer crash keeps the same `webContents.id`
 * but drops the `navigate` subscription — without this reset,
 * {@link requestNavigate} would keep hot-path-sending into a listenerless
 * renderer and the message would be lost instead of queued. Clearing on
 * top-frame navigations (same-document ones keep the JS context, so those
 * are excluded) and on `render-process-gone` makes such windows fall back
 * to the pending slot, which the remounting client hook drains via
 * `get-pending-navigate`.
 *
 * @param win - The freshly created tracked main window.
 */
export function registerReadinessReset(win: BrowserWindow): void {
  const { webContents } = win;
  const clear = (): void => {
    if (readyWebContentsId === webContents.id) readyWebContentsId = null;
  };
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) clear();
  });
  webContents.on('render-process-gone', clear);
}

/**
 * Request navigation to `path`, tolerating a window/renderer that isn't
 * ready yet.
 *
 * If a live window exists and its renderer has already signaled readiness
 * (see {@link resolvePendingNavigate}), the path is delivered immediately
 * over the hot path ({@link sendNavigate}). Otherwise it's stored in the
 * pending slot (last-write-wins) for the renderer to pick up on mount.
 * Either way, `ensureWindow` is called so the window exists and is brought
 * forward — cheap and idempotent when a window is already focused.
 *
 * This is the entry point menu items and `open-url` should use instead of
 * calling `sendNavigate` directly, since neither can guarantee a live,
 * subscribed renderer on the other end.
 *
 * @param getWindow - Point-in-time accessor for the current main window.
 * @param ensureWindow - Focuses the existing main window or creates one
 *   (see `index.ts`'s `showMainWindow`).
 * @param path - A client route path, optionally with a query string.
 */
export function requestNavigate(
  getWindow: () => BrowserWindow | null,
  ensureWindow: () => void,
  path: string
): void {
  const win = getWindow();
  if (win && !win.isDestroyed() && isRendererReady(win)) {
    sendNavigate(win, path);
  } else {
    pendingPath = path;
  }
  ensureWindow();
}

/**
 * Handle the renderer's `get-pending-navigate` invoke (preload-exposed,
 * called by the client's `useElectronNavigate` hook right after it
 * subscribes to `onNavigate` on mount).
 *
 * Marks `webContentsId` as the ready renderer — so a subsequent
 * {@link requestNavigate} call can use the hot path — and hands back
 * whatever path was queued before this renderer had the chance to
 * subscribe. Read-once: the slot is cleared immediately, so a path is only
 * ever delivered once (a second invoke from the same or another renderer
 * returns `null`).
 *
 * @param webContentsId - `event.sender.id` of the invoking renderer.
 * @returns The queued path, or `null` if nothing is pending.
 */
export function resolvePendingNavigate(webContentsId: number): string | null {
  readyWebContentsId = webContentsId;
  const path = pendingPath;
  pendingPath = null;
  return path;
}
