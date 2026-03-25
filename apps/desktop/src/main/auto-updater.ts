import { autoUpdater } from 'electron-updater';
import { dialog, BrowserWindow } from 'electron';
import log from 'electron-log';

/**
 * Set up automatic updates via GitHub Releases.
 *
 * Checks for updates on launch, downloads silently, and prompts
 * the user to restart when a new version is ready.
 *
 * Requires code signing — unsigned builds will fail update verification.
 * Only call this function when signing is configured.
 */
export function setupAutoUpdater(): void {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      dialog
        .showMessageBox(win, {
          type: 'info',
          title: 'Update Ready',
          message: `DorkOS ${info.version} is ready to install.`,
          detail: 'The update will be applied when you restart the app.',
          buttons: ['Restart Now', 'Later'],
        })
        .then(({ response }) => {
          if (response === 0) {
            autoUpdater.quitAndInstall();
          }
        });
    }
  });

  autoUpdater.on('error', (err) => {
    log.error('Auto-update error:', err);
  });

  // Check for updates on launch (non-blocking)
  autoUpdater.checkForUpdatesAndNotify();
}
