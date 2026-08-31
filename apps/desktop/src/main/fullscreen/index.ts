/**
 * Forwards a window's fullscreen state to its renderer (DOR-563).
 *
 * macOS retracts the traffic lights into the auto-hiding menu bar while a
 * window is fullscreen, but the renderer kept reserving their space
 * unconditionally: `AppShell.tsx` held `desktop-darwin:pl-20` on the tab strip
 * while the sidebar was collapsed, and `TitlebarDragStrip.tsx` kept its
 * `h-11` band — a permanent dead gap before the first tab, in the one mode
 * where screen space is the entire point. Nothing forwarded
 * `enter-full-screen`/`leave-full-screen` to the renderer at all, so there
 * was nothing either component could key off of.
 *
 * @module main/fullscreen/index
 */
import type { BrowserWindow } from 'electron';

/** IPC channel the main process pushes fullscreen state on (mirrors the preload and `useElectronFullscreen`). */
export const FULLSCREEN_CHANGE_CHANNEL = 'window:fullscreen-changed';

/** IPC channel a renderer asks this window's current fullscreen state on (mirrors the preload). */
export const GET_FULLSCREEN_STATE_CHANNEL = 'get-fullscreen-state';

/**
 * Subscribe a window's `enter-full-screen`/`leave-full-screen` events and push
 * the resulting boolean to its own renderer on {@link FULLSCREEN_CHANGE_CHANNEL}.
 *
 * Call once per window, right after it is created (mirrors
 * {@link import('../window-state').attachWindowStatePersistence} and the
 * other per-window setup in `createWindow`). A destroyed window is guarded
 * against:
 * `leave-full-screen` can fire during teardown, and sending on a dead
 * `webContents` throws.
 *
 * @param win - The window to watch and push updates to.
 */
export function forwardFullscreenState(win: BrowserWindow): void {
  const send = (isFullScreen: boolean): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(FULLSCREEN_CHANGE_CHANNEL, isFullScreen);
  };
  win.on('enter-full-screen', () => send(true));
  win.on('leave-full-screen', () => send(false));
}
