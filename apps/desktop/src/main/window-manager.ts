import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron';
import type {
  HandlerDetails,
  Event,
  WebContentsWillNavigateEventParams,
  WindowOpenHandlerResponse,
} from 'electron';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyContextMenu } from './context-menu';
import { forwardFullscreenState } from './fullscreen';
import { applyPermissionPolicy } from './permissions';
import { forwardFocusState } from './window-focus';
import {
  attachWindowStatePersistence,
  clampSizeToWorkArea,
  loadValidatedWindowState,
  type WindowState,
} from './window-state';

/**
 * How the cockpit's windows are made: their web preferences, what they are
 * allowed to navigate to, and what happens when the page asks for a second one.
 *
 * Geometry lives next door in `window-state.ts`; what a page may ask the machine
 * for (camera, notifications, clipboard) lives in `permissions/`, applied per
 * window below.
 */

/** Minimum size below which the cockpit's layout stops working. */
const MIN_WINDOW_SIZE = { width: 800, height: 600 };

/** Diagonal offset of a second window from the one that opened it, so it doesn't land exactly on top. */
const CASCADE_OFFSET_PX = 32;

/**
 * How long to wait for the renderer's first frame before showing the window
 * anyway.
 *
 * The window is created hidden and revealed on `ready-to-show` so nobody sees
 * an empty white rectangle before the dark cockpit paints. That event does not
 * fire if the page fails to load — and a window that never appears is far worse
 * than a brief flash — so this is the floor under it.
 */
const SHOW_FALLBACK_MS = 4_000;

/** What kind of window this is, which decides who owns the persisted geometry. */
export type WindowRole = 'primary' | 'secondary';

/** Options for {@link createWindow}. */
export interface CreateWindowOptions {
  /**
   * Live accessor for the app's own origin (`http://localhost:<port>` in a
   * packaged build), read fresh on every link decision.
   *
   * An accessor rather than a value on purpose: the server gets a **new port**
   * when it is restarted after a crash, and a value captured at window-creation
   * time would leave the guards below treating the app's own pages as foreign
   * and handing them to the system browser.
   */
  getRendererUrl?: () => string | undefined;
  /**
   * Absolute URL this window opens on. Only set for a second window the
   * renderer asked for; the primary window resolves its own entry below.
   */
  initialUrl?: string;
  /** Defaults to `primary`. See {@link WindowRole}. */
  role?: WindowRole;
}

/**
 * Is `url` the app's own renderer entry?
 *
 * Three cases, checked in order:
 * 1. The dev server (`ELECTRON_RENDERER_URL`, set by electron-vite for HMR).
 * 2. `rendererUrl` — in a packaged build, the bundled server's own
 *    `http://localhost:<port>` origin (see {@link createWindow}), which
 *    serves the built renderer directly: the packaged app loads via the
 *    server, not `file://`, so the server's CORS allowlist sees a real
 *    origin instead of `null` (see ADR `260712-005315`).
 * 3. A `file://` URL inside the app's own `renderer/` bundle — kept as a
 *    fallback for `electron-vite preview` (no server, no dev URL), which
 *    still loads the built renderer straight off disk.
 *
 * Only those count: an arbitrary `file://` link (e.g. from agent-generated
 * markdown clicked without `target="_blank"`) must NOT pass — it would
 * steer the app window itself onto a raw local file with no way back to
 * the SPA.
 *
 * Used by both link guards in {@link createWindow} to tell the cockpit apart
 * from a stray link that belongs in the system browser.
 *
 * @param url - The URL a navigation or `window.open` is about to load.
 * @param rendererUrl - The app's own origin right now, from
 *   {@link CreateWindowOptions.getRendererUrl}.
 */
export function isOwnOrigin(url: string, rendererUrl?: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol === 'file:') {
    // Same layout as the loadFile fallback below: the built renderer lives
    // in `../renderer` relative to the compiled main-process bundle.
    const rendererDir = resolve(__dirname, '../renderer');
    try {
      const targetPath = resolve(fileURLToPath(target));
      return targetPath === rendererDir || targetPath.startsWith(rendererDir + sep);
    } catch {
      return false;
    }
  }
  const ownOrigin = process.env.ELECTRON_RENDERER_URL || rendererUrl;
  if (!ownOrigin) return false;
  try {
    return target.origin === new URL(ownOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Is this a link the system browser should take?
 *
 * The whole of the shell's outbound policy: `http(s)` leaves, everything else
 * goes nowhere. Exported so the renderer's `open-external` bridge (`index.ts`)
 * enforces the same rule the two link guards below do, rather than a second one
 * that could drift.
 *
 * @param url - The URL a navigation, a `window.open`, or the renderer is asking
 *   to open outside the app.
 */
export function isWebLink(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * The paint colour behind the renderer, matching the cockpit's own background
 * (`--background` in `apps/client/src/index.css`) for the current OS theme.
 *
 * Without it every launch flashed Chromium's default white before the dark
 * cockpit painted. The OS theme is the best proxy the main process has for the
 * app's theme; combined with the hidden-until-`ready-to-show` window below it
 * is only ever seen during a resize repaint.
 */
function shellBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#fafafa';
}

/** Where a second window opens: the same size as the one that spawned it, nudged down-right and kept on screen. */
function cascadeFromFocusedWindow(): WindowState {
  const opener = BrowserWindow.getFocusedWindow();
  const { workArea } = screen.getPrimaryDisplay();
  if (!opener || opener.isDestroyed()) {
    return { ...clampSizeToWorkArea(MIN_WINDOW_SIZE, workArea), isMaximized: false };
  }
  const bounds = opener.getBounds();
  const size = clampSizeToWorkArea(bounds, screen.getDisplayMatching(bounds).workArea);
  return {
    x: bounds.x + CASCADE_OFFSET_PX,
    y: bounds.y + CASCADE_OFFSET_PX,
    ...size,
    isMaximized: false,
  };
}

/**
 * Reveal a window once, whether the renderer painted or the fallback timer
 * gave up on it, re-maximizing first if that is how it was left.
 *
 * `maximize()` has to happen here rather than at construction: a window created
 * with `show: false` and maximized immediately opens un-maximized on macOS.
 *
 * @param win - The window to reveal.
 * @param state - The geometry it was created with.
 */
function revealWhenReady(win: BrowserWindow, state: WindowState): void {
  let shown = false;
  const show = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    clearTimeout(fallback);
    if (state.isMaximized) win.maximize();
    win.show();
  };
  const fallback = setTimeout(show, SHOW_FALLBACK_MS);
  win.once('ready-to-show', show);
}

/**
 * Apply the app's link policy to `win`: what may load in the window, what opens
 * a second window, and what leaves for the system browser.
 *
 * Both guards ask {@link isOwnOrigin} through the live accessor, so they keep
 * working after a server restart moves the app to a new port.
 *
 * @param win - The window to guard.
 * @param options - The same options {@link createWindow} received; a second
 *   window inherits them so it is guarded (and can itself spawn) identically.
 */
function applyLinkPolicy(win: BrowserWindow, options: CreateWindowOptions): void {
  const { getRendererUrl } = options;

  // `target="_blank"` and `window.open()` — chat links, gen-ui widgets,
  // marketplace cards, the command palette's "Open in New Tab".
  //
  // Our own origin becomes a real second cockpit window. It used to be handed
  // to the system browser along with everything else, because this handler
  // looked only at the scheme: asking for a new tab on an agent sent the
  // cockpit to Chrome. The window is built here rather than returned as
  // `{ action: 'allow' }` so it gets the same preload, the same sandboxing and
  // the same guards as the window that opened it — Electron's own path would
  // produce a popup shaped by whatever `features` string the page passed.
  //
  // Everything else is denied a window: http(s) goes to the system browser,
  // anything else goes nowhere. A foreign page in a chromeless BrowserWindow
  // has no navigation UI — a dead end the person cannot get back out of.
  win.webContents.setWindowOpenHandler(({ url }: HandlerDetails): WindowOpenHandlerResponse => {
    if (isOwnOrigin(url, getRendererUrl?.())) {
      createWindow({ ...options, initialUrl: url, role: 'secondary' });
      return { action: 'deny' };
    }
    if (isWebLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Same policy for in-window navigation: an anchor without target="_blank"
  // (or any other navigation-triggering surface) should not be able to steer
  // the app window itself off the SPA — to a foreign origin or to an
  // arbitrary local file. Only the app's own renderer entry passes; http(s)
  // is handed off to the system browser so the link still goes somewhere
  // useful.
  win.webContents.on('will-navigate', (event: Event<WebContentsWillNavigateEventParams>) => {
    if (isOwnOrigin(event.url, getRendererUrl?.())) return;
    event.preventDefault();
    if (isWebLink(event.url)) void shell.openExternal(event.url);
  });
}

/**
 * Point `win` at the renderer.
 *
 * In dev: electron-vite sets `ELECTRON_RENDERER_URL` for HMR. In a packaged
 * build: the bundled server's own localhost origin (server-spawn.ts sets
 * `CLIENT_DIST_PATH` so the server serves it) rather than `file://` — the
 * server's CORS allowlist and Better Auth's trusted-origins check both need a
 * real origin, not `null`, and this makes the renderer's fetches same-origin
 * besides. `electron-vite preview` (no server, no dev URL) falls back to the
 * built index.html straight off disk.
 *
 * A second window overrides all of that with the exact URL that was asked for
 * — it is already an own-origin absolute URL, verified by the window-open
 * handler that created it.
 *
 * Exported for `renderer-health/`, which has to put the app back on
 * screen after its recovery page has been showing. Resolving the entry a
 * second time over there would be a second answer to "where does the cockpit
 * live", and the two would drift the first time this one changed.
 *
 * @param win - The window to load.
 * @param options - See {@link CreateWindowOptions}.
 */
export function loadRenderer(win: BrowserWindow, options: CreateWindowOptions): void {
  const rendererUrl = options.getRendererUrl?.();
  if (options.initialUrl) {
    void win.loadURL(options.initialUrl);
  } else if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Create a cockpit window. On macOS it uses the hidden-inset title bar
 * (traffic-light styling); on Windows/Linux it falls back to the native window
 * frame with standard min/max/close controls.
 *
 * The **primary** window restores and saves the remembered geometry. A
 * **secondary** window — one the renderer asked for with `window.open` on the
 * app's own origin — cascades off whatever is focused and is deliberately not
 * remembered: two windows writing one geometry file would just overwrite each
 * other.
 *
 * @param options - See {@link CreateWindowOptions}.
 * @returns The created BrowserWindow instance.
 */
export function createWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const isPrimary = (options.role ?? 'primary') === 'primary';
  const state = isPrimary ? loadValidatedWindowState() : cascadeFromFocusedWindow();

  const win = new BrowserWindow({
    ...state,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: 'DorkOS',
    backgroundColor: shellBackgroundColor(),
    // Created hidden and revealed on the renderer's first frame — see
    // revealWhenReady.
    show: false,
    // macOS gets the inset title bar the renderer's top region is laid out
    // around (with the traffic lights nudged to match). Everything else keeps
    // the native OS frame: on Windows a `hidden`/`hiddenInset` title bar drops
    // the minimize/maximize/close controls, and we draw no custom overlay to
    // replace them — that would leave the window with no way to close it.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  applyLinkPolicy(win, options);
  // Right-click. Electron shows no context menu unless the embedder builds one,
  // and this window is where every other per-window policy is applied. It takes
  // the same outbound-link rule the guards above use, so "Open Link in Browser"
  // can never offer to leave for something they would refuse.
  applyContextMenu(win, isWebLink);
  // What the page may ask the machine for. Same live origin accessor the link
  // guards use, so a permission and a link are judged by one answer to "is this
  // our own page?" — including after a crash restart moves the server's port.
  applyPermissionPolicy(win.webContents.session, (url) =>
    isOwnOrigin(url, options.getRendererUrl?.())
  );
  revealWhenReady(win, state);
  loadRenderer(win, options);
  forwardFullscreenState(win);
  forwardFocusState(win);
  if (isPrimary) attachWindowStatePersistence(win);

  return win;
}

/**
 * The app's own origin right now, or `undefined` when the renderer is not being
 * served from one (dev, or before the server has a port).
 *
 * Shared by `index.ts` and passed into every window as
 * {@link CreateWindowOptions.getRendererUrl}.
 *
 * @param getServerPort - Point-in-time accessor for the server's port.
 */
export function makeRendererUrlAccessor(
  getServerPort: () => number | null
): () => string | undefined {
  return () => {
    const port = getServerPort();
    return app.isPackaged && port ? `http://localhost:${port}` : undefined;
  };
}
