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

/** IPC channel this renderer claims `Cmd/Ctrl+W` on (mirrors `CLOSE_TAB_SUBSCRIBE_CHANNEL` in close-tab.ts). */
const CLOSE_TAB_SUBSCRIBE_CHANNEL = 'close-tab:subscribe';

/** IPC channel this renderer gives `Cmd/Ctrl+W` back on (mirrors `CLOSE_TAB_UNSUBSCRIBE_CHANNEL` in close-tab.ts). */
const CLOSE_TAB_UNSUBSCRIBE_CHANNEL = 'close-tab:unsubscribe';

/** IPC channel a mounted renderer reports itself alive on (mirrors `ALIVE_CHANNEL` in renderer-health/index.ts). */
const ALIVE_CHANNEL = 'renderer:alive';

/** IPC channel the recovery page's "Try Again" goes out on (mirrors `TRY_AGAIN_CHANNEL` in renderer-health/index.ts). */
const TRY_AGAIN_CHANNEL = 'renderer:try-again';

/** IPC channel the recovery page's "Reset and Relaunch" goes out on (mirrors `RESET_CHANNEL` in renderer-health/index.ts). */
const RESET_CHANNEL = 'renderer:reset-and-relaunch';

/** IPC channel the recovery page's "Save Diagnostic Report" goes out on (mirrors `DIAGNOSTICS_CHANNEL` in renderer-health/index.ts). */
const DIAGNOSTICS_CHANNEL = 'renderer:save-diagnostics';

/** IPC channel the main process pushes fullscreen state on (mirrors `FULLSCREEN_CHANGE_CHANNEL` in fullscreen.ts). */
const FULLSCREEN_CHANGE_CHANNEL = 'window:fullscreen-changed';

/**
 * How many live `onCloseTab` subscriptions this renderer holds.
 *
 * Counted here rather than in the main process so main sees exactly one
 * subscribe and one unsubscribe per renderer, however many times the client
 * mounts and unmounts its handler.
 */
let closeTabSubscriptions = 0;

/**
 * Preload script — runs in a privileged context before the renderer loads.
 *
 * Exposes a minimal API to the renderer via contextBridge.
 * Never expose raw ipcRenderer — only specific invoke/sendSync calls.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Get the port the Express server is listening on (synchronous), or `null`
   * when it is not serving — during startup, after a crash, between restarts.
   * The main process answers with exactly what `getServerPort()` in
   * `server-process.ts` holds, so `null` is a normal answer and every caller
   * must handle it.
   */
  getServerPort: (): number | null => ipcRenderer.sendSync('get-server-port'),
  /**
   * Report that this page really came up — the renderer half of the shell's
   * renderer supervision (`renderer-health/index.ts`).
   *
   * **Call it exactly where the app decides it has booted**, which in the
   * cockpit is the boot sentinel's `done()` in `apps/client/index.html`. Two
   * definitions of "the app is up" would eventually disagree, and the one that
   * decides whether the shell reloads the window has to be the strict one.
   *
   * Silence past the shell's deadline starts a recovery ladder that ends in a
   * static recovery page, so this is not optional decoration: a renderer that
   * paints and never calls this will be reloaded, then cache-cleared, then
   * relaunched.
   */
  reportAlive: (): void => ipcRenderer.send(ALIVE_CHANNEL),
  /**
   * Reload the app from the recovery page, resetting the shell's failure
   * count.
   *
   * The three recovery calls answer **only** the shell's own recovery page —
   * the main process refuses them from any other document, including the
   * cockpit. They restart the app and wipe stored state, and the cockpit runs
   * third-party extension code that must not be able to reach either.
   */
  retryRenderer: (): Promise<void> => ipcRenderer.invoke(TRY_AGAIN_CHANNEL),
  /**
   * Clear the window's caches and local storage, then relaunch the app. See
   * {@link retryRenderer} for who may call this.
   */
  resetAndRelaunch: (): Promise<void> => ipcRenderer.invoke(RESET_CHANNEL),
  /**
   * Write a diagnostic archive to the Desktop and reveal it. See
   * {@link retryRenderer} for who may call this.
   */
  saveDiagnosticReport: (): Promise<void> => ipcRenderer.invoke(DIAGNOSTICS_CHANNEL),
  /** The current platform (darwin, win32, linux). */
  platform: process.platform,
  /**
   * Open a URL in the system browser.
   *
   * The one case the renderer cannot handle itself: `window.open` at the app's
   * own `http://localhost:<port>` origin opens a second cockpit window, which
   * is the opposite of leaving. Only `http`/`https` URLs are opened; anything
   * else is ignored, matching the shell's link guards exactly.
   *
   * @param url - The URL to hand to the browser.
   * @returns Resolves once the shell has been asked to open it.
   */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
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
   * Subscribe to `Cmd/Ctrl+W` ("Close" in the Window menu — it is relabelled
   * "Close Tab" by whichever change first subscribes here, not before).
   *
   * **Subscribing is what claims the keystroke.** Until you call this, and
   * again after you unsubscribe, `Cmd/Ctrl+W` closes the window immediately
   * with no round trip — the behaviour it had before tabs existed. Subscribe on
   * mount, unsubscribe on unmount, and nothing in between is ambiguous.
   *
   * **The contract, precisely** — once subscribed, the window closes unless you
   * claim the keystroke:
   *
   * - Return `true` from `cb` when you closed a tab. The window stays open.
   * - Return `false` (or nothing) when there was no tab to close. The window
   *   closes immediately — that is the right answer for the last tab.
   * - Throw, and the window closes: a handler that fails must not strand the
   *   keystroke.
   * - Take longer than 3 seconds and the window closes anyway. A person
   *   pressing Cmd+W must never get nothing, so the main process does not wait
   *   on you indefinitely: it races you, and the window wins the tie. **Do your
   *   work synchronously** — a promise is not awaited, and an async handler
   *   loses the race even when it succeeds.
   *
   * Register **one** subscriber. Several may register, but each answers
   * independently and the first answer decides — a `false` from one closes the
   * window even if another would have handled it.
   *
   * `Cmd/Ctrl+Shift+W` ("Close Window") never reaches here; it always closes
   * the window.
   *
   * @param cb - Called on every `Cmd/Ctrl+W`. Return whether you handled it.
   * @returns An unsubscribe function that removes the listener and, once the
   *   last one is gone, hands `Cmd/Ctrl+W` back. Safe to call more than once.
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
    if (++closeTabSubscriptions === 1) ipcRenderer.send(CLOSE_TAB_SUBSCRIBE_CHANNEL);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      ipcRenderer.removeListener(CLOSE_TAB_CHANNEL, listener);
      if (--closeTabSubscriptions === 0) ipcRenderer.send(CLOSE_TAB_UNSUBSCRIBE_CHANNEL);
    };
  },
  /**
   * Subscribe to this window's fullscreen state (DOR-563). macOS retracts the
   * traffic lights into the auto-hiding menu bar while fullscreen holds, so
   * the renderer drops the space it otherwise reserves for them (see
   * `AppShell.tsx` and `TitlebarDragStrip.tsx`).
   *
   * @returns An unsubscribe function that removes the listener.
   */
  onFullscreenChange: (cb: (isFullScreen: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isFullScreen: boolean): void =>
      cb(isFullScreen);
    ipcRenderer.on(FULLSCREEN_CHANGE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(FULLSCREEN_CHANGE_CHANNEL, listener);
  },
  /**
   * Whether this window is fullscreen right now. Called once by
   * `useElectronFullscreen` right after it subscribes via
   * {@link onFullscreenChange}, so a renderer that mounts (or remounts) after
   * the window already entered fullscreen still recovers the current state
   * instead of waiting for the next transition.
   */
  getFullscreenState: (): Promise<boolean> => ipcRenderer.invoke('get-fullscreen-state'),
});
