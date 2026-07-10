import { BrowserWindow, screen, shell } from 'electron';
import type {
  Display,
  Rectangle,
  HandlerDetails,
  Event,
  WebContentsWillNavigateEventParams,
} from 'electron';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { app } from 'electron';

/** Persisted window geometry and maximize state. */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1200, height: 800, isMaximized: false };

/** Minimum on-screen overlap (px, both axes) for a saved position to be kept. */
const MIN_VISIBLE_PX = 100;

/** Debounce window for resize/move saves, so dragging doesn't thrash disk I/O. */
const SAVE_DEBOUNCE_MS = 500;

const STATE_FILE = join(app.getPath('userData'), 'window-state.json');

/** Load saved window state from disk. Returns defaults on first launch or error. */
function loadWindowState(): WindowState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Write window state to disk, creating the userData directory if needed. */
function persistWindowState(state: WindowState): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

/**
 * Does `bounds` overlap `workArea` by at least {@link MIN_VISIBLE_PX} pixels
 * in both axes? Used to decide whether a persisted window position is still
 * usable, e.g. after a monitor was disconnected.
 *
 * @param bounds - The candidate window rectangle.
 * @param workArea - A display's usable work area (excludes menu bar/dock).
 */
export function isMeaningfullyVisible(bounds: Rectangle, workArea: Rectangle): boolean {
  const visibleWidth =
    Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
  const visibleHeight =
    Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
    Math.max(bounds.y, workArea.y);
  return visibleWidth >= MIN_VISIBLE_PX && visibleHeight >= MIN_VISIBLE_PX;
}

/** Shrink `size` so it fits within `workArea`, preserving aspect as-is (no upscaling). */
export function clampSizeToWorkArea(
  size: { width: number; height: number },
  workArea: Rectangle
): { width: number; height: number } {
  return {
    width: Math.min(size.width, workArea.width),
    height: Math.min(size.height, workArea.height),
  };
}

/** Center a rectangle of `size` within `workArea`. */
function centerInWorkArea(
  size: { width: number; height: number },
  workArea: Rectangle
): { x: number; y: number } {
  return {
    x: workArea.x + Math.round((workArea.width - size.width) / 2),
    y: workArea.y + Math.round((workArea.height - size.height) / 2),
  };
}

/**
 * Validate a persisted window state against the currently connected
 * displays. If the saved position no longer meaningfully overlaps any
 * display's work area (e.g. an external monitor was unplugged), the
 * position is discarded and the window is centered on the primary display
 * instead, with its size clamped to fit. A position that is still at least
 * partially visible is kept unchanged.
 *
 * @param state - The persisted window state to validate.
 * @param displays - All currently connected displays.
 * @param primaryDisplay - The display to fall back to when the saved
 *   position is unusable.
 */
export function validateWindowState(
  state: WindowState,
  displays: Display[],
  primaryDisplay: Display
): WindowState {
  if (state.x === undefined || state.y === undefined) {
    // No saved position (first launch) — let the OS place the window, but
    // still guard against a persisted size larger than the current screen.
    const size = clampSizeToWorkArea(state, primaryDisplay.workArea);
    return { ...state, ...size };
  }

  const bounds: Rectangle = { x: state.x, y: state.y, width: state.width, height: state.height };
  const isVisible = displays.some((display) => isMeaningfullyVisible(bounds, display.workArea));

  if (isVisible) {
    return state;
  }

  const size = clampSizeToWorkArea(state, primaryDisplay.workArea);
  const position = centerInWorkArea(size, primaryDisplay.workArea);
  return { ...size, ...position, isMaximized: state.isMaximized };
}

/**
 * Derive the state to persist for `win`. When maximized, the previously
 * saved restored bounds are preserved (so un-maximizing restores correctly)
 * and only the maximized flag is updated; otherwise the current bounds are
 * captured.
 *
 * @param win - The window to capture state from.
 * @param previousState - The last persisted state, used to preserve
 *   restored bounds while maximized.
 */
export function shapeWindowState(win: BrowserWindow, previousState: WindowState): WindowState {
  if (win.isMaximized()) {
    return { ...previousState, isMaximized: true };
  }
  // When maximized, getBounds() returns screen-sized dimensions — this
  // branch only runs when the window is in its restored state.
  return { ...win.getBounds(), isMaximized: false };
}

/**
 * Is `url` the app's own renderer entry — the dev server
 * (`ELECTRON_RENDERER_URL`, set by electron-vite for HMR) or, once packaged,
 * a `file://` URL inside the app's own `renderer/` bundle (the built
 * `index.html` and its assets)?
 *
 * Only that bundle counts: an arbitrary `file://` link (e.g. from
 * agent-generated markdown clicked without `target="_blank"`) must NOT pass —
 * it would steer the app window itself onto a raw local file with no way
 * back to the SPA.
 *
 * Used by the `will-navigate` guard in {@link createWindow} to tell in-app
 * routing apart from a stray link that should open in the system browser
 * instead of hijacking the app window.
 *
 * @param url - The URL a `will-navigate` event is about to load.
 */
export function isOwnOrigin(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol === 'file:') {
    // Same layout as loadFile below: the built renderer lives in
    // `../renderer` relative to the compiled main-process bundle.
    const rendererDir = resolve(__dirname, '../renderer');
    try {
      const targetPath = resolve(fileURLToPath(target));
      return targetPath === rendererDir || targetPath.startsWith(rendererDir + sep);
    } catch {
      return false;
    }
  }
  if (!process.env.ELECTRON_RENDERER_URL) return false;
  try {
    return target.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin;
  } catch {
    return false;
  }
}

/**
 * Create the main BrowserWindow with native macOS styling.
 *
 * @returns The created BrowserWindow instance.
 */
export function createWindow(): BrowserWindow {
  const persisted = loadWindowState();
  const state = validateWindowState(persisted, screen.getAllDisplays(), screen.getPrimaryDisplay());

  const win = new BrowserWindow({
    ...state,
    minWidth: 800,
    minHeight: 600,
    title: 'DorkOS',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Link policy for both guards below: http(s) goes to the system browser
  // via shell.openExternal; everything else is denied, except the app's own
  // renderer entry (isOwnOrigin), which only in-window navigation may load.
  //
  // `target="_blank"` (chat links, gen-ui widgets, marketplace cards, …) and
  // `window.open()` would otherwise spawn a second, chromeless BrowserWindow
  // with no navigation UI — a dead end the user can't get back out of.
  win.webContents.setWindowOpenHandler(({ url }: HandlerDetails) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Same policy for in-window navigation: an anchor without target="_blank"
  // (or any other navigation-triggering surface) should not be able to steer
  // the app window itself off the SPA — to a foreign origin or to an
  // arbitrary local file. Only the app's own renderer entry passes; http(s)
  // is handed off to the system browser so the link still goes somewhere
  // useful.
  win.webContents.on('will-navigate', (event: Event<WebContentsWillNavigateEventParams>) => {
    if (isOwnOrigin(event.url)) return;
    event.preventDefault();
    if (event.url.startsWith('http://') || event.url.startsWith('https://')) {
      void shell.openExternal(event.url);
    }
  });

  if (state.isMaximized) win.maximize();

  // In dev: electron-vite sets ELECTRON_RENDERER_URL for HMR
  // In prod: load the built index.html from dist/renderer/
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Debounce resize/move saves so dragging/resizing doesn't write on every
  // frame; save-on-close always fires immediately and wins any pending save.
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = (): void => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      persistWindowState(shapeWindowState(win, loadWindowState()));
    }, SAVE_DEBOUNCE_MS);
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', () => {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    persistWindowState(shapeWindowState(win, loadWindowState()));
  });

  return win;
}
