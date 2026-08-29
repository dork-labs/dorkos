import { app, dialog } from 'electron';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import log from 'electron-log';
import { installedBundleVersion, resetAppBundleCache } from './app-bundle';
import { purgeStaleStagedUpdates } from './cache';
import { prepareUpdateRestart } from '../auto-updater';
import { clearUpdateIntent, isNewerVersion } from '../updater-intent';

/**
 * Noticing that the app was replaced on disk while it kept running.
 *
 * Dragging a fresh copy into `/Applications` is the remedy support gives
 * someone whose updater is wedged — and on this app it quietly does nothing.
 * DorkOS stays alive in the menu bar after its window closes, so the old
 * process is still there afterwards, and the single-instance lock turns
 * "open the new one" into "focus the old one". The person installs the fix,
 * looks at the same bug, and has no way to tell why.
 *
 * So the two moments a person plainly expects the new version — launching it
 * again, and clicking back into the window — are where this looks.
 *
 * @module main/updater/manual-overwrite
 */

/** Index of the leftmost (default) button in a `buttons` array. */
const RESTART_BUTTON = 0;

/**
 * The disk version already offered, so a person is asked once per version
 * rather than once per focus.
 *
 * Set before the dialog opens, not after it is answered: window focus fires
 * again the moment a modal takes and returns focus, and asking that question
 * twice over one install is how a helpful prompt becomes a loop.
 */
let promptedVersion: string | null = null;

/**
 * Clear the module's per-run prompt state.
 *
 * @internal Exported for testing only.
 */
export function resetManualOverwriteState(): void {
  promptedVersion = null;
  resetAppBundleCache();
}

/**
 * Say what happened and offer the only thing that fixes it.
 *
 * @param getWindow - Point-in-time accessor for the window to anchor to.
 * @param version - The version now sitting on disk.
 * @returns Whether the person chose to restart.
 */
async function offerRestart(
  getWindow: () => BrowserWindow | null,
  version: string
): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'info',
    title: 'A Newer DorkOS Is Installed',
    message: `DorkOS ${version} was installed. Restart to use it.`,
    detail:
      'DorkOS kept running while the new version was installed, so this window is still the ' +
      'old one. Restarting takes a few seconds and your work is saved.',
    buttons: ['Restart Now', 'Later'],
    defaultId: RESTART_BUTTON,
    cancelId: 1,
  };
  const win = getWindow();
  const { response } =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
  return response === RESTART_BUTTON;
}

/**
 * Compare the app on disk with the app that is running, and offer to restart
 * into it when disk is newer.
 *
 * Silent in every other case, which is nearly every call: same version, older
 * version, no readable bundle, or a version already offered.
 *
 * Unpackaged builds are excluded outright. A dev build runs from Electron's own
 * bundle, whose `Info.plist` names Electron's version — a number far above any
 * DorkOS release, which would turn every window focus in development into a
 * prompt to restart into an update that does not exist.
 *
 * @param getWindow - Point-in-time accessor for the window to anchor the dialog
 *   to; an unanchored box is shown when there is none.
 */
export async function checkForManualOverwrite(
  getWindow: () => BrowserWindow | null
): Promise<void> {
  if (!app.isPackaged) return;
  const installed = installedBundleVersion();
  if (installed === null) return;

  const running = app.getVersion();
  if (!isNewerVersion(installed, running)) return;
  if (promptedVersion === installed) return;
  promptedVersion = installed;

  log.info(
    `[updater] DorkOS ${installed} is installed on disk while ${running} is still running — ` +
      'the app was replaced underneath this process.'
  );

  if (!(await offerRestart(getWindow, installed))) return;

  // The agent question is asked BEFORE `app.relaunch()`, never after.
  // `relaunch()` is a standing instruction for whenever this process next
  // exits: arming it and then having the person say "Keep Working" would leave
  // the app quietly primed to reopen itself on an unrelated quit hours later.
  if (!(await prepareUpdateRestart())) return;

  // `autoInstallOnAppQuit` means Squirrel applies whatever is still staged as
  // this process exits — and anything staged that the copy on disk has already
  // overtaken would land ON TOP of it, undoing the very install this restart
  // exists to pick up. Judged against the version about to run, not the one
  // running now, which is the whole reason that argument exists.
  if (purgeStaleStagedUpdates(installed).length > 0) {
    // The attempt just recorded names the update that has now been deleted, so
    // nothing will install it and the next launch would count a failure against
    // an install nobody attempted. Two of those stop offering a plain restart
    // at all, for an update that was never the problem.
    clearUpdateIntent();
  }

  log.info(`[updater] Restarting into the installed ${installed}.`);
  app.relaunch();
  app.quit();
}
