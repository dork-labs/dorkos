/**
 * Forwards a window's OS-level focus state to its renderer (DOR-254).
 *
 * The dim-on-blur effect has to answer "does the WINDOW have OS focus", not
 * "does the DOCUMENT have DOM focus" — those are different questions, and the
 * renderer can only ask the second one on its own. Clicking into an `<iframe>`
 * the cockpit hosts (`McpAppFrame`, `CanvasBrowserContent`) moves DOM focus
 * into that frame and fires the outer document's `window` `blur` event with
 * no OS-level focus change at all — the app is still the frontmost window.
 * A renderer that dimmed on its own `blur`/`focus` would dim itself the
 * moment someone used an embedded browser or canvas, for the rest of the
 * session, which is worse than not dimming at all. Only the main process
 * knows which window the OS actually gave focus to.
 *
 * @module main/window-focus
 */
import type { BrowserWindow } from 'electron';

/** IPC channel the main process pushes focus state on (mirrors the preload and `useWindowFocusDimming`). */
export const FOCUS_CHANGE_CHANNEL = 'window:focus-changed';

/** IPC channel a renderer asks this window's current focus state on (mirrors the preload). */
export const GET_FOCUS_STATE_CHANNEL = 'get-focus-state';

/**
 * Subscribe a window's `focus`/`blur` events and push the resulting boolean
 * to its own renderer on {@link FOCUS_CHANGE_CHANNEL}.
 *
 * Call once per window, right after it is created (mirrors
 * `forwardFullscreenState` in `../fullscreen`, and the other per-window setup
 * in `createWindow`). A destroyed window is guarded against: `blur` can fire
 * during teardown, and sending on a dead `webContents` throws.
 *
 * @param win - The window to watch and push updates to.
 */
export function forwardFocusState(win: BrowserWindow): void {
  const send = (focused: boolean): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(FOCUS_CHANGE_CHANNEL, focused);
  };
  win.on('focus', () => send(true));
  win.on('blur', () => send(false));
}
