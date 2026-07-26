import { contextBridge, ipcRenderer } from 'electron';
// Type-only import — erased at build time, so the preload bundle never pulls
// in the main process's `electron-updater` dependency. The `update:status`
// channel string is duplicated below rather than imported as a value for the
// same reason.
import type { UpdateStatus } from '../main/auto-updater';

/** IPC channel the main process pushes {@link UpdateStatus} events on (mirrors `UPDATE_STATUS_CHANNEL` in auto-updater.ts). */
const UPDATE_STATUS_CHANNEL = 'update:status';

/** IPC channel `Cmd/Ctrl+W` arrives on (mirrors `CLOSE_TAB_CHANNEL` in close-tab.ts). */
const CLOSE_TAB_CHANNEL = 'close-tab';

/** IPC channel the answer to {@link CLOSE_TAB_CHANNEL} goes back on (mirrors `CLOSE_TAB_ACK_CHANNEL` in close-tab.ts). */
const CLOSE_TAB_ACK_CHANNEL = 'close-tab:ack';

/**
 * Preload script — runs in a privileged context before the renderer loads.
 *
 * Exposes a minimal API to the renderer via contextBridge.
 * Never expose raw ipcRenderer — only specific invoke/sendSync calls.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /** Get the port the Express server is listening on (synchronous). */
  getServerPort: (): number => ipcRenderer.sendSync('get-server-port'),
  /** Get the app version from package.json (synchronous). */
  getAppVersion: (): string => ipcRenderer.sendSync('get-app-version'),
  /** The current platform (darwin, win32, linux). */
  platform: process.platform,
  /**
   * Subscribe to main-process navigation requests (menu items, the dock
   * menu, and — Chunk D — `dorkos://` deep links), all funneled through the
   * single `navigate` IPC channel (ADR 260709-210223). `cb` receives the
   * client route path to navigate to.
   *
   * @returns An unsubscribe function that removes the listener.
   */
  onNavigate: (cb: (path: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string): void => cb(path);
    ipcRenderer.on('navigate', listener);
    return () => ipcRenderer.removeListener('navigate', listener);
  },
  /**
   * Pending-navigation handoff: also marks this renderer as "ready" for the
   * `navigate` hot path (see `navigation.ts`'s `resolvePendingNavigate`).
   * Called once by `useElectronNavigate` on mount, right after subscribing
   * via `onNavigate` — covers a path requested (menu click, `dorkos://` deep
   * link) before this window's renderer existed or had subscribed yet.
   *
   * @returns The queued path, or `null` if nothing is pending.
   */
  getPendingNavigate: (): Promise<string | null> => ipcRenderer.invoke('get-pending-navigate'),
  /**
   * Restart the app to install a downloaded update — wired to the in-app
   * card's "Restart to install" button. Only meaningful once an
   * {@link onUpdateStatus} `downloaded` event has arrived.
   */
  restartToUpdate: (): void => ipcRenderer.send('update:restart'),
  /**
   * Subscribe to native updater lifecycle events (checking → available →
   * downloading → downloaded, or not-available / error) so the in-app sidebar
   * card can reflect them. `cb` receives a discriminated-union status.
   *
   * @returns An unsubscribe function that removes the listener.
   */
  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => cb(status);
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener);
  },
  /**
   * Replay the last actionable update status (`downloading`/`downloaded`), or
   * `null`. Called once on mount right after {@link onUpdateStatus}, so a
   * window recreated after `update-downloaded` fired still recovers a waiting
   * update (macOS close→reopen).
   */
  getUpdateStatus: (): Promise<UpdateStatus | null> => ipcRenderer.invoke('get-update-status'),
  /**
   * Subscribe to `Cmd/Ctrl+W` ("Close Tab" in the Window menu).
   *
   * **The contract, precisely** — the window closes unless you claim the
   * keystroke:
   *
   * - Return `true` from `cb` when you closed a tab. The window stays open.
   * - Return `false` (or nothing) when there was no tab to close. The window
   *   closes immediately — that is the right answer for the last tab.
   * - Take longer than ~250 ms, throw, or never subscribe at all, and the
   *   window closes anyway. A person pressing Cmd+W must never get nothing, so
   *   the main process does not wait on you: it races you, and the window wins
   *   the tie. **Do your work synchronously**; a promise is not awaited, and an
   *   async handler will lose the race even when it succeeds.
   *
   * Register **one** subscriber. Several may register, but each answers
   * independently and the first answer decides — a `false` from one closes the
   * window even if another would have handled it.
   *
   * `Cmd/Ctrl+Shift+W` ("Close Window") never reaches here; it always closes
   * the window.
   *
   * @param cb - Called on every `Cmd/Ctrl+W`. Return whether you handled it.
   * @returns An unsubscribe function that removes the listener.
   */
  onCloseTab: (cb: () => boolean | void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: number): void => {
      let handled = false;
      try {
        handled = cb() === true;
      } catch (err) {
        // A handler that throws must not strand the keystroke — report "not
        // handled" so the window closes, which is what Cmd+W did before tabs.
        console.error('[dorkos] close-tab handler threw; closing the window instead.', err);
      }
      ipcRenderer.send(CLOSE_TAB_ACK_CHANNEL, requestId, handled);
    };
    ipcRenderer.on(CLOSE_TAB_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CLOSE_TAB_CHANNEL, listener);
  },
});
