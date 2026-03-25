import { app, BrowserWindow, ipcMain } from 'electron';
import { createWindow } from './window-manager';
import { startServer, stopServer, getServerPort } from './server-process';
import { setupMenu } from './menu';
// import { setupAutoUpdater } from './auto-updater';

let mainWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

// Register IPC handlers for the preload bridge.
// These must be registered before the window is created.
ipcMain.on('get-server-port', (event) => {
  event.returnValue = getServerPort();
});

ipcMain.on('get-app-version', (event) => {
  event.returnValue = app.getVersion();
});

app.on('ready', async () => {
  // 1. Start Express in a UtilityProcess on a free port
  serverPort = await startServer();

  // 2. Create the main window (loads renderer pointing at the server)
  mainWindow = createWindow(serverPort);

  // 3. Set up the native macOS menu bar
  setupMenu(mainWindow);

  // 4. Check for updates in the background (non-blocking)
  // Uncomment when code signing is configured (Phase 3).
  // setupAutoUpdater();
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
    mainWindow = createWindow(serverPort);
  }
});
