import { autoUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import { app, dialog } from 'electron';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import log from 'electron-log';

/** The IPC channel the main process pushes {@link UpdateStatus} events to the renderer on. */
export const UPDATE_STATUS_CHANNEL = 'update:status';

/**
 * The native updater's lifecycle, mirrored to the renderer so the in-app
 * sidebar card can reflect it (the desktop counterpart to the web/npm upgrade
 * card). Sent on {@link UPDATE_STATUS_CHANNEL} as a discriminated union.
 *
 * This type is re-declared as `DesktopUpdateStatus` in the client's
 * `vite-env.d.ts` — the client package can't import from the desktop main
 * process, so the two must be kept in sync by hand.
 */
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

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
 * True when electron-updater failed only because the *newest* GitHub release
 * exists but its update-metadata file (`latest-mac.yml` on macOS, `latest.yml`
 * on Windows) has not been attached yet — the window between `/system:release`
 * publishing the release and `desktop-release.yml` uploading the installers.
 * The GitHub provider throws `Cannot find latest-mac.yml in the latest release
 * artifacts (…): HttpError: 404` for exactly this case.
 *
 * This is not a real failure: there is simply nothing installable yet, so we
 * surface it as "no update available" rather than an error, never showing the
 * user a stack trace for the normal release-in-progress gap. Draft-until-
 * attached in the release workflow closes this window on the happy path; this
 * stays as defense-in-depth for a partial upload, a failed single-platform
 * build, or any other transient not-yet-ready release state.
 *
 * Detection prefers electron-updater's stable error `code`
 * (`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`, set at the throw site) so it is immune
 * to message-wording changes and can never misfire on a genuine connectivity
 * error that merely mentions "404". The message regex is only a fallback for a
 * provider/version that omits the code.
 */
function isReleaseNotReadyError(err: Error): boolean {
  if ((err as { code?: unknown }).code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    return true;
  }
  const message = err.message ?? '';
  return /Cannot find .*\.ya?ml in the latest release/i.test(message);
}

/**
 * The last *actionable* update status (`downloading` / `downloaded`), retained
 * so a renderer that mounts *after* the event fired can recover it via the
 * `get-update-status` IPC — the analogue of `navigation.ts`'s pending-navigate
 * replay. This matters on macOS: closing the window (`mainWindow` → null, app
 * stays alive) then reopening mounts a fresh React tree that would otherwise
 * never learn a `downloaded` update is waiting, stranding it with no in-app
 * restart affordance (the native dialog having been suppressed).
 *
 * Only `downloading`/`downloaded` are stored — the transient
 * `checking`/`available`/`not-available`/`error` states are not worth
 * replaying and must never overwrite a stored `downloaded`.
 */
let lastStatus: UpdateStatus | null = null;

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

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('Update available:', info.version);
    sendUpdateStatus({ state: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ state: 'not-available' });
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

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    sendUpdateStatus({ state: 'downloading', percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    checkingInteractively = false;
    // The renderer's in-app card is the primary "restart to install" surface.
    sendUpdateStatus({ state: 'downloaded', version: event.version });

    // Avoid double-prompting: when a window is present, the in-app card owns
    // the restart affordance, so suppress the native dialog. Only fall back to
    // the native "Update Ready" dialog when there's no window to host the card
    // (macOS keeps the app alive with zero windows open).
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) return;

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
    // A not-yet-ready release (metadata file 404) means "nothing to install
    // right now", not a failure. Surface it like `update-not-available` so the
    // sidebar card never turns red and an interactive check gets a calm notice
    // instead of a raw HttpError stack trace.
    if (isReleaseNotReadyError(err)) {
      log.info('Update metadata not published yet; treating as no update available.', err.message);
      sendUpdateStatus({ state: 'not-available' });
      if (checkingInteractively) {
        void showMessageBox({
          type: 'info',
          title: 'Update Not Ready Yet',
          message: 'A newer version is being prepared.',
          detail:
            'The latest release is still finishing its upload. Please check again in a few minutes.',
        });
      }
      checkingInteractively = false;
      return;
    }

    sendUpdateStatus({ state: 'error', message: err.message });
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
 * flow (shared with the background path), a calm "not ready yet" notice when
 * the newest release exists but its installer has not finished uploading (see
 * {@link isReleaseNotReadyError}), or an error dialog for a genuine failure. A
 * background check never shows an "up to date" dialog — only this path does.
 *
 * No-ops when `!app.isPackaged`, matching `setupAutoUpdater`. The menu item
 * is already disabled in that case; this guard is defensive in case the two
 * ever fall out of sync.
 */
export function checkForUpdatesInteractive(): void {
  if (!app.isPackaged) return;

  checkingInteractively = true;
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    // electron-updater both emits `error` and rejects the returned promise on
    // failure. The `error` handler runs first and clears the flag, so if it is
    // already false the outcome was surfaced there — skip to avoid a double
    // dialog. This branch only handles a rejection with no matching `error`
    // event.
    if (!checkingInteractively) return;
    checkingInteractively = false;
    const error = err instanceof Error ? err : new Error(String(err));
    // Reaching here means no `error` event fired, so no status was sent yet —
    // resolve the renderer card off `checking` to match the outcome (the
    // `error` event path already sends its own status before this runs).
    if (isReleaseNotReadyError(error)) {
      sendUpdateStatus({ state: 'not-available' });
      void showMessageBox({
        type: 'info',
        title: 'Update Not Ready Yet',
        message: 'A newer version is being prepared.',
        detail:
          'The latest release is still finishing its upload. Please check again in a few minutes.',
      });
      return;
    }
    sendUpdateStatus({ state: 'error', message: error.message });
    void showMessageBox({
      type: 'error',
      title: 'Update Check Failed',
      message: 'DorkOS could not check for updates.',
      detail: error.message,
    });
  });
}

/**
 * Restart the app to apply a downloaded update, driven by the renderer's
 * in-app card (the "Restart to install" button) via the `update:restart` IPC.
 *
 * Shares `autoUpdater.quitAndInstall()` with the native restart dialog, so
 * both paths tear down the server cleanly through the `before-quit` dance in
 * `index.ts`. No-ops when `!app.isPackaged`, matching {@link setupAutoUpdater}
 * — an unpackaged build has no installer to run.
 */
export function restartToUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.quitAndInstall();
}

/**
 * The last actionable status ({@link lastStatus}), for the `get-update-status`
 * replay IPC. Returns `null` until a `downloading`/`downloaded` event fires.
 */
export function getLastUpdateStatus(): UpdateStatus | null {
  return lastStatus;
}

/** Push an {@link UpdateStatus} to the tracked main window's renderer, mirroring how `navigation.ts` sends `navigate`. */
function sendUpdateStatus(status: UpdateStatus): void {
  // Latch only the actionable states for replay; transient ones must not clobber
  // a stored `downloaded` (a background re-check emits checking→available).
  if (status.state === 'downloading' || status.state === 'downloaded') {
    lastStatus = status;
  }
  const win = getMainWindow?.();
  if (win && !win.isDestroyed()) win.webContents.send(UPDATE_STATUS_CHANNEL, status);
}

/** Show a message box anchored to the current main window, falling back to an unanchored dialog if none is tracked. */
function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const win = getMainWindow?.();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}
