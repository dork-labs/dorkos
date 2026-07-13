import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { createWindow } from './window-manager';
import { startServer, stopServer, getServerPort } from './server-process';
import { setupMenu, setupDockMenu } from './menu';
import { setupAboutPanel } from './about';
import { setupAutoUpdater, restartToUpdate, getLastUpdateStatus } from './auto-updater';
import {
  findDeepLinkArg,
  parseDeepLink,
  registerReadinessReset,
  requestNavigate,
  resolvePendingNavigate,
} from './navigation';

/** The custom URL scheme `dorkos://` deep links arrive on. */
const DEEP_LINK_PROTOCOL = 'dorkos';

let mainWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

/**
 * Create the main window and track its lifecycle. On macOS the app keeps
 * running after the window closes, so the reference is nulled on 'closed'
 * to prevent later handlers (second-instance, activate) from touching a
 * destroyed BrowserWindow.
 */
function createTrackedWindow(): void {
  // The renderer only loads via the server's localhost origin in a packaged
  // build — dev keeps loading through electron-vite's ELECTRON_RENDERER_URL
  // (createWindow checks that first regardless of this argument).
  const rendererUrl = app.isPackaged && serverPort ? `http://localhost:${serverPort}` : undefined;
  mainWindow = createWindow(rendererUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // A reload or renderer crash keeps this window's webContents.id but drops
  // the renderer's `navigate` subscription — reset the deep-link readiness
  // mark so requestNavigate queues instead of sending into the void.
  registerReadinessReset(mainWindow);
}

/**
 * Point-in-time accessor for the tracked main window. Passed to the menu
 * (rather than a captured `BrowserWindow`) so click handlers always see the
 * current window, even after it has been recreated.
 */
function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Whether an `invoke` came from the tracked main window's renderer. Guards the
 * read-once/replay handlers (`get-pending-navigate`, `get-update-status`) so a
 * stray invoke (devtools, a future auxiliary window) can't steal state meant
 * for the primary renderer. `webContents.id` is unique per instance, so this
 * naturally rejects a destroyed-then-recreated window's old id.
 */
function isTrackedRenderer(event: Electron.IpcMainInvokeEvent): boolean {
  const win = getMainWindow();
  return !!win && !win.isDestroyed() && event.sender.id === win.webContents.id;
}

/**
 * Focus the existing main window (restoring it first if minimized), or
 * create one if none exists yet. Shared by `second-instance` and the Dock
 * menu's "Show DorkOS" item so there is one path for "bring the app forward".
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (serverPort) createTrackedWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/**
 * Route a raw `dorkos://` URL through the app's navigation path, from
 * whichever platform channel delivered it (macOS `open-url`, or a Windows/Linux
 * `process.argv` / `second-instance` scan). A well-formed link navigates via
 * {@link requestNavigate} — which ensures/focuses a window and tolerates a
 * renderer that isn't subscribed yet; a malformed one just brings the app
 * forward.
 *
 * @param url - The raw deep-link URL string.
 */
function handleDeepLinkUrl(url: string): void {
  const path = parseDeepLink(url);
  if (path) {
    requestNavigate(getMainWindow, showMainWindow, path);
  } else {
    showMainWindow();
  }
}

// Only one instance of the app may run at a time — two copies would each
// spawn their own server process against the same ~/.dork SQLite store.
// This must run before any ready-work (IPC handlers, window creation).
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // A second launch attempt was blocked by the lock above; bring the
  // existing window to the front instead of doing nothing. If the window
  // was closed (macOS keeps the app alive with zero windows), recreate it.
  //
  // On Windows/Linux a warm `dorkos://` activation arrives as the `argv` of
  // this event (the OS launches a second instance that fails the lock and
  // hands its command line here), so scan it for a deep link and route it;
  // with no link attached it's a plain re-focus. macOS routes warm deep
  // links through `open-url` instead, and passes no meaningful argv here.
  app.on('second-instance', (_event, argv: string[]) => {
    const url = Array.isArray(argv) ? findDeepLinkArg(argv) : null;
    if (url) {
      handleDeepLinkUrl(url);
    } else {
      showMainWindow();
    }
  });

  // Register `dorkos://` as this app's protocol handler. Cross-platform and
  // safe to call before 'ready'; idempotent across launches.
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);

  // macOS delivers `dorkos://` activations through `open-url` — including a
  // cold-start deep link, which can fire before 'ready' (before any window or
  // server exists). Per Electron's docs this listener must be registered as
  // early as possible, before 'ready', to reliably catch that case. This
  // event is macOS-only, so scope its registration there; Windows/Linux
  // deliver deep links via argv instead (see below and `second-instance`).
  if (process.platform === 'darwin') {
    app.on('open-url', (event, url) => {
      event.preventDefault();
      handleDeepLinkUrl(url);
    });
  } else {
    // Windows/Linux cold-start deep link: the OS appends the `dorkos://` URL
    // to this process's command line. Scan it once at startup and route it
    // through the same pending-navigation path — the queued path is delivered
    // once the window's renderer subscribes on mount (see navigation.ts).
    const coldStartUrl = findDeepLinkArg(process.argv);
    if (coldStartUrl) handleDeepLinkUrl(coldStartUrl);
  }

  // Register IPC handlers for the preload bridge.
  // These must be registered before the window is created.
  ipcMain.on('get-server-port', (event) => {
    event.returnValue = getServerPort();
  });

  ipcMain.on('get-app-version', (event) => {
    event.returnValue = app.getVersion();
  });

  // Update surface for the renderer's in-app card (see auto-updater.ts). The
  // card triggers a restart-to-install; the updater pushes lifecycle events
  // back on the `update:status` channel and retains the last actionable status
  // for `get-update-status` to replay to a renderer that mounted after the
  // event fired (macOS close→reopen). No-ops in dev (unpackaged builds can't
  // apply updates).
  ipcMain.on('update:restart', () => {
    restartToUpdate();
  });

  // Replay the last `downloading`/`downloaded` status — called once by the
  // client's useDesktopUpdater hook right after it subscribes on mount, so a
  // window recreated after the event recovers a waiting update. Guarded to the
  // tracked renderer like `get-pending-navigate`.
  ipcMain.handle('get-update-status', (event) => {
    if (!isTrackedRenderer(event)) return null;
    return getLastUpdateStatus();
  });

  // Renderer-readiness + pending-navigation pickup (see navigation.ts) —
  // called by the client's useElectronNavigate hook right after it
  // subscribes to `onNavigate` on mount. Only the tracked main window's
  // renderer may mark readiness or drain the slot: a stray invoke (devtools,
  // a future auxiliary window) must not steal the pending path or trick
  // requestNavigate into hot-path-sending to the wrong webContents.
  ipcMain.handle('get-pending-navigate', (event) => {
    if (!isTrackedRenderer(event)) return null;
    return resolvePendingNavigate(event.sender.id);
  });

  app.on('ready', async () => {
    // 1. Start Express in a UtilityProcess on a free port. A rejection here
    // previously vanished silently — Electron doesn't surface a rejected
    // async 'ready' handler anywhere — leaving the app running with zero
    // windows and no way for the user to know why. showErrorBox is
    // synchronous/blocking, so it's guaranteed to be seen before the app quits.
    try {
      serverPort = await startServer();
    } catch (err) {
      dialog.showErrorBox(
        "DorkOS couldn't start",
        "DorkOS couldn't start its background server, so it can't continue. " +
          `Try restarting the app. If this keeps happening, check ~/Library/Logs/DorkOS for details.\n\n${
            err instanceof Error ? err.message : String(err)
          }`
      );
      app.quit();
      return;
    }

    // 2. Create the main window (the renderer fetches the server port via IPC)
    createTrackedWindow();

    // 3. Set up the native macOS menu bar, About panel, and Dock menu
    setupMenu(getMainWindow, showMainWindow);
    setupAboutPanel();
    setupDockMenu(showMainWindow);

    // 4. Check for updates in the background (non-blocking). No-ops in dev
    // (unpackaged builds can't apply updates) — see auto-updater.ts.
    setupAutoUpdater(getMainWindow);
  });

  // macOS convention: closing all windows does NOT quit the app.
  // The app stays in the dock until the user presses Cmd+Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Clean up the server process before the app quits.
  // Electron does not await async before-quit handlers, so we
  // prevent quit, run cleanup, then quit explicitly.
  //
  // This also has to interplay correctly with `autoUpdater.quitAndInstall()`
  // (auto-updater.ts): it arms the native installer, then calls `app.quit()`.
  // That first quit hits preventDefault() and runs stopServer(), then the
  // `isQuitting` guard lets the second, explicit quit() through — so install
  // + relaunch only happens after the server has shut down cleanly.
  // `autoInstallOnAppQuit = true` is the fallback if quitAndInstall() is never
  // called directly. Do not "simplify" this dance without preserving that.
  let isQuitting = false;
  app.on('before-quit', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    isQuitting = true;
    stopServer().finally(() => app.quit());
  });

  // macOS convention: clicking the dock icon re-creates the window
  // if all windows have been closed.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
      createTrackedWindow();
    }
  });
}
