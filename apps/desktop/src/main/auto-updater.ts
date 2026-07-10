import { autoUpdater } from 'electron-updater';
import type { UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import { app, dialog } from 'electron';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import log from 'electron-log';

/** How often to re-check for updates in the background once the app is running. */
const BACKGROUND_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Point-in-time accessor for the main window, supplied by `index.ts` at
 * `setupAutoUpdater` time and reused by `checkForUpdatesInteractive`.
 *
 * Stored rather than imported: `index.ts` calls `setupAutoUpdater`, so this
 * module importing `index.ts` back (to fetch the window) would form a cycle.
 * `menu.ts` receives the same accessor as a parameter for the same reason.
 */
let getMainWindow: (() => BrowserWindow | null) | null = null;

/** True while a foreground ("Check for Updates…") check is in flight — gates which events show a dialog vs. only log. */
let checkingInteractively = false;

/**
 * Set up automatic updates via GitHub Releases: checks on launch and every
 * 4 hours in the background, downloads silently, and prompts the user to
 * restart once an update is ready (see `checkForUpdatesInteractive` for the
 * menu-triggered foreground path, which shares these event listeners).
 *
 * No-ops entirely when `!app.isPackaged` — dev builds are unsigned and
 * unpackaged, so electron-updater has no signature to verify and no
 * installer artifact to apply; wiring it up in dev would only produce
 * confusing errors.
 *
 * @param mainWindowAccessor - Point-in-time accessor for the current main
 *   window, used to anchor dialogs. Stored for later use by
 *   `checkForUpdatesInteractive`.
 */
export function setupAutoUpdater(mainWindowAccessor: () => BrowserWindow | null): void {
  getMainWindow = mainWindowAccessor;

  if (!app.isPackaged) return;

  autoUpdater.logger = log;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('Update available:', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    if (checkingInteractively) {
      void showMessageBox({
        type: 'info',
        title: 'No Updates Available',
        message: "You're up to date",
        detail: `DorkOS ${app.getVersion()} is the latest version.`,
      });
    }
    checkingInteractively = false;
  });

  autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    checkingInteractively = false;
    void showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `DorkOS ${event.version} is ready to install.`,
      detail: 'The update will be applied when you restart the app.',
      buttons: ['Restart Now', 'Later'],
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err: Error) => {
    if (checkingInteractively) {
      void showMessageBox({
        type: 'error',
        title: 'Update Check Failed',
        message: 'DorkOS could not check for updates.',
        detail: err.message,
      });
    } else {
      log.error('Auto-update error:', err);
    }
    checkingInteractively = false;
  });

  // Check on launch, then every 4 hours for as long as the app runs.
  // unref() so this repeating timer never keeps the process alive on its own.
  void autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => {
    void autoUpdater.checkForUpdatesAndNotify();
  }, BACKGROUND_CHECK_INTERVAL_MS).unref();
}

/**
 * Trigger a foreground update check from the "Check for Updates…" menu item.
 *
 * Unlike the background checks in `setupAutoUpdater`, every outcome is
 * surfaced to the user via a native dialog anchored to the main window:
 * no update found ("You're up to date"), a download-then-restart-prompt
 * flow (shared with the background path), or an error dialog. A background
 * check never shows an "up to date" dialog — only this path does.
 *
 * No-ops when `!app.isPackaged`, matching `setupAutoUpdater`. The menu item
 * is already disabled in that case; this guard is defensive in case the two
 * ever fall out of sync.
 */
export function checkForUpdatesInteractive(): void {
  if (!app.isPackaged) return;

  checkingInteractively = true;
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    checkingInteractively = false;
    void showMessageBox({
      type: 'error',
      title: 'Update Check Failed',
      message: 'DorkOS could not check for updates.',
      detail: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Show a message box anchored to the current main window, falling back to an unanchored dialog if none is tracked. */
function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const win = getMainWindow?.();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}
