import { app, BrowserWindow, ipcMain } from 'electron';
import { createWindow } from './window-manager';
import { startServer, stopServer, getServerPort } from './server-process';
import { setupMenu, setupDockMenu } from './menu';
import { setupAboutPanel } from './about';
import { setupAutoUpdater } from './auto-updater';
import { parseDeepLink, requestNavigate, resolvePendingNavigate } from './navigation';

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
  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
  app.on('second-instance', () => {
    showMainWindow();
  });

  // Register `dorkos://` as this app's protocol handler. Safe to call
  // before 'ready' and idempotent across launches.
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);

  // macOS delivers `dorkos://` activations here — including a cold-start
  // deep link, which can fire before 'ready' (before any window or server
  // exists). Per Electron's docs this listener must be registered as early
  // as possible, before 'ready', to reliably catch that case.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const path = parseDeepLink(url);
    if (path) {
      // requestNavigate both ensures/focuses a window and tolerates a
      // renderer that isn't subscribed yet (pending-navigation handoff).
      requestNavigate(getMainWindow, showMainWindow, path);
    } else {
      // Malformed/unknown deep link: just bring the app forward.
      showMainWindow();
    }
  });

  // Register IPC handlers for the preload bridge.
  // These must be registered before the window is created.
  ipcMain.on('get-server-port', (event) => {
    event.returnValue = getServerPort();
  });

  ipcMain.on('get-app-version', (event) => {
    event.returnValue = app.getVersion();
  });

  // Renderer-readiness + pending-navigation pickup (see navigation.ts) —
  // called by the client's useElectronNavigate hook right after it
  // subscribes to `onNavigate` on mount.
  ipcMain.handle('get-pending-navigate', (event) => resolvePendingNavigate(event.sender.id));

  app.on('ready', async () => {
    // 1. Start Express in a UtilityProcess on a free port
    serverPort = await startServer();

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
