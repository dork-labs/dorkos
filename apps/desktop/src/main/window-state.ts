import { app, screen } from 'electron';
import type { BrowserWindow, Display, Rectangle } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import log from 'electron-log';

/**
 * Where the window goes: reading, validating and persisting its geometry.
 *
 * Split out of `window-manager.ts` because "what a window is" (its web
 * preferences, its link policy, how many of them there are) and "where a window
 * sits on which monitor" are different jobs with different failure modes — and
 * only one of them has to survive a person unplugging a screen.
 *
 * Exactly one window owns this state. See {@link attachWindowStatePersistence}.
 */

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

/**
 * The state as last read from or written to disk.
 *
 * The main process is the only writer, so it can simply remember what it wrote.
 * Before this, every debounced save re-read the file with `readFileSync` on the
 * UI thread purely to supply {@link shapeWindowState}'s `previousState` — a
 * synchronous disk read per drag-settle, for a value already in memory.
 */
let lastKnownState: WindowState | null = null;

/** Whether {@link watchDisplayChanges} has already attached its listeners. */
let displayWatchInstalled = false;

/** Read the persisted state, from memory after the first time. Defaults on first launch or a corrupt file. */
function loadWindowState(): WindowState {
  if (lastKnownState) return lastKnownState;
  try {
    lastKnownState = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as WindowState;
  } catch {
    lastKnownState = { ...DEFAULT_STATE };
  }
  return lastKnownState;
}

/** Write window state to disk, creating the userData directory if needed. */
function persistWindowState(state: WindowState): void {
  lastKnownState = state;
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (err) {
    // Losing the remembered geometry is a next-launch annoyance, not a reason
    // to take the window down — and this runs from a `close` handler, where an
    // uncaught throw would strand the quit sequence.
    log.warn('[window] Could not save the window position.', err);
  }
}

/**
 * Drop the cached state and the display-watch guard.
 *
 * @internal Exported for testing only.
 */
export function resetWindowStateModule(): void {
  lastKnownState = null;
  displayWatchInstalled = false;
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
 * Validate a persisted window state against the currently connected displays.
 *
 * A position that no longer meaningfully overlaps any display's work area (an
 * external monitor was unplugged) is discarded and the window is centered on
 * the primary display instead. A position that is still at least partially
 * visible is kept — but its **size is still clamped**, to the work area of the
 * display it actually overlaps. That clamp used to be missing from this branch,
 * and it is the one that matters most: a window saved while full-screen reports
 * bounds covering the entire display, menu-bar strip included, and is still
 * "visible" by every measure — so it came back jammed under the menu bar with
 * its title bar unreachable.
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
  const host = displays.find((display) => isMeaningfullyVisible(bounds, display.workArea));

  if (host) {
    return { ...state, ...clampSizeToWorkArea(state, host.workArea) };
  }

  const size = clampSizeToWorkArea(state, primaryDisplay.workArea);
  const position = centerInWorkArea(size, primaryDisplay.workArea);
  return { ...size, ...position, isMaximized: state.isMaximized };
}

/**
 * Derive the state to persist for `win`.
 *
 * While maximized **or full-screen**, the previously saved restored bounds are
 * preserved (so un-maximizing restores correctly) and only the flag is updated;
 * otherwise the current bounds are captured. Full-screen has to be in that
 * first branch: `isMaximized()` reports `false` for a full-screen window while
 * `getBounds()` returns the whole display, so capturing bounds there persists a
 * rectangle no restored window should ever have.
 *
 * Full-screen is deliberately folded into `isMaximized` rather than persisted
 * as a state of its own: relaunching maximized is the right answer for someone
 * who quit full-screen, and the moment they leave full-screen a `resize` fires
 * and re-saves their real geometry.
 *
 * @param win - The window to capture state from.
 * @param previousState - The last persisted state, used to preserve
 *   restored bounds while maximized or full-screen.
 */
export function shapeWindowState(win: BrowserWindow, previousState: WindowState): WindowState {
  if (win.isMaximized() || win.isFullScreen()) {
    return { ...previousState, isMaximized: true };
  }
  return { ...win.getBounds(), isMaximized: false };
}

/** The geometry a freshly created primary window should open with. */
export function loadValidatedWindowState(): WindowState {
  return validateWindowState(
    loadWindowState(),
    screen.getAllDisplays(),
    screen.getPrimaryDisplay()
  );
}

/**
 * Persist `win`'s geometry as it changes.
 *
 * **Attach this to one window only.** Two windows sharing the file would race
 * each other's writes and the person would get whichever one moved last — which
 * is why a second cockpit window (see `window-manager.ts`) is deliberately not
 * remembered.
 *
 * @param win - The primary window.
 */
export function attachWindowStatePersistence(win: BrowserWindow): void {
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    persistWindowState(shapeWindowState(win, loadWindowState()));
  };

  // Debounce resize/move saves so dragging/resizing doesn't write on every
  // frame; save-on-close always fires immediately and wins any pending save.
  const scheduleSave = (): void => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      save();
    }, SAVE_DEBOUNCE_MS);
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', () => {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    save();
  });
}

/**
 * Move stranded windows back onto a connected display when the screens change.
 *
 * {@link validateWindowState} only runs when a window is created, so a window
 * left on a monitor that is then unplugged stayed unreachable until the app was
 * relaunched — the person's only recourse being to plug the monitor back in.
 * Watching `display-removed` and `display-metrics-changed` (which also covers a
 * resolution or scale-factor change that shrinks the desktop out from under a
 * window) closes that gap while the app is running.
 *
 * Idempotent: repeated calls do not stack listeners.
 *
 * @param getWindows - Every window that should be rescued, looked up at
 *   event-time — the set changes as windows open and close.
 */
export function watchDisplayChanges(getWindows: () => BrowserWindow[]): void {
  if (displayWatchInstalled) return;
  displayWatchInstalled = true;
  const rescueAll = (): void => {
    for (const win of getWindows()) rescueWindow(win);
  };
  screen.on('display-removed', rescueAll);
  screen.on('display-metrics-changed', rescueAll);
}

/**
 * Bring one window back into reach if the current displays no longer hold it.
 *
 * Skipped for a minimized, maximized or full-screen window: none of those has
 * bounds the person is looking at, and the OS re-lays them out itself when the
 * display set changes.
 *
 * @param win - The window to check.
 */
function rescueWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;

  const bounds = win.getBounds();
  const rescued = validateWindowState(
    { ...bounds, isMaximized: false },
    screen.getAllDisplays(),
    screen.getPrimaryDisplay()
  );
  const moved =
    rescued.x !== bounds.x ||
    rescued.y !== bounds.y ||
    rescued.width !== bounds.width ||
    rescued.height !== bounds.height;
  if (!moved) return;

  log.info('[window] The window was off-screen after a display change; moving it back.');
  win.setBounds({ x: rescued.x, y: rescued.y, width: rescued.width, height: rescued.height });
}
