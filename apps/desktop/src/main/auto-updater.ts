import { autoUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import { app, autoUpdater as nativeAutoUpdater, dialog } from 'electron';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import log from 'electron-log';
import { confirmInterruptingAgents } from './quit-guard';
import {
  clearUpdateIntent,
  isAtLeastVersion,
  isNewerVersion,
  readUpdateIntent,
  writeUpdateIntent,
} from './updater-intent';

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
  | { state: 'error'; message: string }
  /**
   * An update was staged, the app restarted for it, and the version that came
   * back up is still the old one — the failure Squirrel cannot report in-process
   * (see `updater-intent.ts`). Decided at launch, never during a session.
   */
  | { state: 'install-failed'; version: string; attempts: number };

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
 * The update status a freshly-mounted renderer should start from, retained so a
 * renderer that mounts *after* the event fired can recover it via the
 * `get-update-status` IPC — the analogue of
 * `navigation.ts`'s pending-navigate replay. This matters on macOS: closing the
 * window (`mainWindow` → null, app stays alive) then reopening mounts a fresh
 * React tree that would otherwise never learn a `downloaded` update is waiting,
 * stranding it with no in-app restart affordance (the native dialog having been
 * suppressed).
 *
 * Whatever the renderer would be showing, in other words — {@link foldForReplay}
 * applies the renderer's own folding rule, so this is not "the last actionable
 * status" but "the status a window opened right now should start from". An
 * `error` that superseded a `downloaded` is stored, because a renderer that
 * replayed the `downloaded` instead would offer a restart the live window had
 * already stopped offering.
 */
let lastStatus: UpdateStatus | null = null;

/**
 * Whether this run has already written an install intent.
 *
 * Both paths that install an update end in a quit, and the in-app restart runs
 * through BOTH of them — `beginUpdateRestart()` records the attempt, then
 * `quitAndInstall()`'s own `app.quit()` reaches the quit sequence, which asks
 * again. Without this, one restart would count as two attempts and push the
 * card to "Download fresh copy" after a single ordinary failure.
 *
 * Cleared by {@link resetUpdateRestartState}, which the updater's `error`
 * handler calls: a restart that Squirrel rejected while the app stayed up is
 * over, and the next click is a genuinely new attempt.
 */
let intentRecorded = false;

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

  // Judge the previous attempt before asking for a new one. Ordering matters
  // twice over: a verdict of `install-failed` has to be latched before the
  // launch check starts emitting, and the check that follows will re-download
  // the very version that just failed — which {@link foldForReplay} is what
  // stops from reading as good news.
  judgeLastInstallAttempt();

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
    // Read before the send, which may retire the failure this asks about.
    const knownBad = failedInstallStandingFor(event.version);
    // The renderer's in-app card is the primary "restart to install" surface.
    sendUpdateStatus({ state: 'downloaded', version: event.version });

    // Avoid double-prompting: when a window is present, the in-app card owns
    // the restart affordance, so suppress the native dialog. Only fall back to
    // the native "Update Ready" dialog when there's no window to host the card
    // (macOS keeps the app alive with zero windows open).
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) return;

    if (knownBad) {
      // This exact version already failed to install, and the 4-hourly check
      // re-stages it indefinitely — so this dialog would offer, over and over,
      // the one action known not to work.
      //
      // Silence rather than a second dialog offering the download page: there
      // is no window here, so acting on anything means opening one, and doing
      // that shows the card that already carries the honest remedy. A native
      // dialog would only duplicate the platform download map into the main
      // process to say the same thing a beat earlier.
      log.info(
        `[updater] Not offering a restart for ${event.version}: it is already recorded as failing to install.`
      );
      return;
    }

    void showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `DorkOS ${event.version} is ready to install.`,
      detail: 'The update will be applied when you restart the app.',
      buttons: ['Restart Now', 'Later'],
    }).then(({ response }) => {
      // Same path as the in-app card, so the "agents are still working"
      // question and the window-all-closed suppression apply here too.
      if (response === 0) void beginUpdateRestart();
    });
  });

  // Electron's *native* updater announces the install-quit as it begins, which
  // is the most precise "the restart is happening now" signal available — it
  // arrives on the deferred macOS branch too, whenever Squirrel finally
  // finishes. Refreshing here keeps the confirmation valid for a restart that
  // took longer than the grace window.
  //
  // A refinement, never the mechanism: it is verified to fire from
  // electron-updater's `BaseUpdater` (`out/BaseUpdater.js` emits it by hand
  // before `app.quit()`) and from Electron's own MSIX updater, but on macOS it
  // comes from the C++ binding, which could not be verified from here. Nothing
  // above depends on it firing.
  nativeAutoUpdater.on('before-quit-for-update', () => {
    armUpdateRestart();
  });

  autoUpdater.on('error', (err: Error) => {
    // Whatever else this error is, it means no restart is happening. On macOS
    // this is how an armed restart realistically dies: `quitAndInstall()` took
    // its deferred branch and returned, and Squirrel then rejected the update.
    // Neither piece of state may outlive the attempt.
    resetUpdateRestartState();

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
 * How long a confirmed restart may skip the quit confirmation.
 *
 * The skip exists because the person authorised this exact interruption
 * moments ago; it is that authorisation, not a flag, that has to expire. Ten
 * minutes is far longer than Squirrel needs to pull an already-downloaded
 * update over the loopback proxy and check its signature, and short enough
 * that a restart which silently never happens cannot disable the confirmation
 * for a working day. Expiring early costs one extra dialog during an update.
 * Expiring late costs agents killed without being asked, so it errs short.
 */
const RESTART_CONFIRMED_GRACE_MS = 10 * 60_000;

/**
 * Whether an update restart is under way, for the sole purpose of keeping the
 * "DorkOS is still running" notice quiet while it happens.
 *
 * `quitAndInstall()` closes every window and only *then* calls `app.quit()`, so
 * `window-all-closed` fires exactly as if a person had closed the last window
 * by hand — and without this it did, complete with a Quit button, in the middle
 * of an update, burning the one-time notice for good. `isQuitting()` cannot
 * cover that: on this path `before-quit` comes afterwards.
 *
 * **This one deliberately survives a `quitAndInstall()` that has not quit yet.**
 * On macOS those are indistinguishable from the outside: `MacUpdater`
 * (`out/MacUpdater.js`) quits only `if (this.squirrelDownloadedUpdate)` and
 * otherwise registers a deferred `update-downloaded` listener and **returns**,
 * with the restart still very much on its way. Clearing this on that branch
 * puts the notice back in the middle of the update — the exact bug it exists to
 * prevent — via the fast-click path, which is the likely one.
 *
 * Being set too long is cheap: the notice is skipped for that close and shown
 * at the next one, because `announceBackgroundRunning` writes its ledger only
 * on the path that actually shows the dialog. It is never allowed to stop a
 * quit (see `index.ts`), so it cannot strand anyone. It is cleared on any
 * updater `error`, which is how a rejected Squirrel update ends.
 */
let restartArmed = false;

/**
 * When the person confirmed the restart, or `null` if they have not.
 *
 * Separate from {@link restartArmed} because the two have opposite tolerances,
 * and one flag serving both is what broke here. Left set too long, this one
 * silently kills mid-run agents on an unrelated quit — so unlike the notice
 * state it is spent on use ({@link consumeUpdateRestart}) and expires
 * ({@link RESTART_CONFIRMED_GRACE_MS}).
 */
let restartConfirmedAt: number | null = null;

/**
 * Is an update restart under way? A peek, for `window-all-closed`, which fires
 * *during* the restart and must not spend the confirmation the quit still needs.
 */
export function isRestartingToUpdate(): boolean {
  return restartArmed;
}

/**
 * Take the person's restart confirmation, if it is still good: `true` means
 * this quit is the restart they already answered for, and the quit guard should
 * not ask again. Spent on read.
 */
export function consumeUpdateRestart(): boolean {
  const confirmedAt = restartConfirmedAt;
  restartConfirmedAt = null;
  return confirmedAt !== null && Date.now() - confirmedAt <= RESTART_CONFIRMED_GRACE_MS;
}

/** Record that a restart is under way and freshly authorised. */
function armUpdateRestart(): void {
  restartArmed = true;
  restartConfirmedAt = Date.now();
}

/**
 * Clear the module's per-run update-restart state.
 *
 * @internal Exported for testing only.
 */
export function resetUpdateRestartState(): void {
  restartArmed = false;
  restartConfirmedAt = null;
  intentRecorded = false;
}

/**
 * Write down that the update now waiting is about to be installed, so the next
 * launch can tell whether it was.
 *
 * Called from **both** paths that install one: the in-app/native restart
 * ({@link beginUpdateRestart}) and the ordinary quit that installs on the way
 * out (`autoInstallOnAppQuit`, reached through the quit sequence in
 * `quit-guard.ts`). One helper for both, and idempotent per run, because the
 * restart path goes through the quit sequence too — see {@link intentRecorded}.
 *
 * Records nothing unless an update is genuinely staged — see
 * {@link pendingInstallVersion} — so an ordinary quit with no update waiting
 * writes no file and the next launch has nothing to judge.
 */
export function recordUpdateInstallIntent(): void {
  if (!app.isPackaged || intentRecorded) return;
  const version = pendingInstallVersion();
  if (!version) return;
  intentRecorded = true;
  writeUpdateIntent(version);
}

/**
 * The version this quit is about to hand to the installer, or `null` when a
 * quit installs nothing.
 *
 * Two states mean an update is staged on disk, and **both have to count**:
 *
 * - `downloaded` — the ordinary case, staged during this session.
 * - `install-failed` — staged during an earlier session and still sitting
 *   there. `autoInstallOnAppQuit` hands it to Squirrel again on every quit, so
 *   each of those quits is a further attempt. Counting only `downloaded`
 *   froze `attempts` at 1 for ever: the count that decides "stop re-offering
 *   the restart" could never reach 2, and the warn line reported one attempt
 *   for a machine on its tenth.
 */
function pendingInstallVersion(): string | null {
  if (lastStatus?.state === 'downloaded') return lastStatus.version;
  if (lastStatus?.state === 'install-failed') return lastStatus.version;
  return null;
}

/**
 * Arm the installer and restart, once anything mid-run has been accounted for.
 *
 * The question is asked **here**, not from `before-quit`, because by then the
 * answer cannot change anything: on Windows `quitAndInstall()` has already run
 * the installer before it quits, and on macOS it may have handed off to
 * Squirrel and taken the windows with it. Asked from here, "Keep Working"
 * genuinely costs nothing — the installer was never armed, and the update still
 * lands on the next ordinary quit.
 */
async function beginUpdateRestart(): Promise<void> {
  if (!(await confirmInterruptingAgents('restart'))) return;

  // Armed before the call, because on the branch that quits straight away the
  // windows are gone before this function resumes.
  armUpdateRestart();
  recordUpdateInstallIntent();
  autoUpdater.quitAndInstall();
}

/**
 * Restart the app to apply a downloaded update, driven by the renderer's
 * in-app card (the "Restart to install" button) via the `update:restart` IPC.
 *
 * Shares {@link beginUpdateRestart} with the native restart dialog, so both
 * paths ask the same question and tear the server down through the same quit
 * sequence (`quit-guard.ts`). No-ops when `!app.isPackaged`, matching
 * {@link setupAutoUpdater} — an unpackaged build has no installer to run.
 */
export async function restartToUpdate(): Promise<void> {
  if (!app.isPackaged) return;
  await beginUpdateRestart();
}

/**
 * The status a renderer mounting now should start from ({@link lastStatus}),
 * for the `get-update-status` replay IPC. `null` until the first check says
 * anything.
 */
export function getLastUpdateStatus(): UpdateStatus | null {
  return lastStatus;
}

/**
 * Decide whether the last install attempt landed, and say so.
 *
 * Runs once per launch, before the first check. A recorded intent whose version
 * the running app has reached is a success — the file goes, and nothing is
 * shown, because a working update is not news. A version the running app has
 * NOT reached is the failure Squirrel could not report: the record is kept (it
 * is what counts the attempts), and the renderer is told, so the card can offer
 * the one remedy that bypasses Squirrel entirely.
 */
function judgeLastInstallAttempt(): void {
  const intent = readUpdateIntent();
  if (!intent) return;

  const running = app.getVersion();
  if (isAtLeastVersion(running, intent.offeredVersion)) {
    clearUpdateIntent();
    return;
  }

  log.warn(
    `[updater] Update ${intent.offeredVersion} did not install: still running ${running} ` +
      `after ${intent.attempts} attempt(s).`
  );
  sendUpdateStatus({
    state: 'install-failed',
    version: intent.offeredVersion,
    attempts: intent.attempts,
  });
}

/**
 * Fold a status into the one kept for replay.
 *
 * **This is `foldStatus` from the renderer (`use-desktop-updater.ts`), rule for
 * rule**, and it has to stay that way: what a window recreated by
 * `get-update-status` shows must be what the window that stayed open shows. It
 * used to be a looser "latch the actionable ones", and the gap was a real lie —
 * `downloaded` then `error` stored the `downloaded`, so closing and reopening
 * the window brought "Restart to install" back from the dead.
 *
 * So an `error` replaces a stored `downloaded`, a transient
 * (`checking`/`available`/`not-available`) cannot clear a stored download, and
 * a recorded install failure is cleared **only** by a strictly newer version
 * finishing its download — the updater re-stages the exact version that just
 * failed within minutes of every launch.
 *
 * The one knowing divergence: version ordering here is
 * {@link isNewerVersion} (full semver), while the renderer uses the client's
 * shared `isNewer` (numeric core only). They agree on every version our release
 * train produces and can only differ on a prerelease, which the updater channel
 * never offers.
 *
 * @param prev - What is currently stored.
 * @param next - The status just sent.
 */
function foldForReplay(prev: UpdateStatus | null, next: UpdateStatus): UpdateStatus | null {
  if (prev?.state === 'install-failed') {
    const replaced = next.state === 'downloaded' && isNewerVersion(next.version, prev.version);
    return replaced ? next : prev;
  }
  if (REPLACING_STATES.has(next.state)) return next;
  if (prev && (prev.state === 'downloading' || prev.state === 'downloaded')) return prev;
  return next;
}

/** States that replace whatever is showing, rather than deferring to it. */
const REPLACING_STATES: ReadonlySet<UpdateStatus['state']> = new Set([
  'downloading',
  'downloaded',
  'install-failed',
  'error',
]);

/**
 * Is a recorded install failure still standing against `version`?
 *
 * True when the app already knows this exact update (or an older one) will not
 * install. The staged copy on disk is unchanged, so every path that would offer
 * to install it — the native restart dialog most of all — is offering something
 * that cannot work.
 *
 * @param version - The version just staged.
 */
function failedInstallStandingFor(version: string): boolean {
  return lastStatus?.state === 'install-failed' && !isNewerVersion(version, lastStatus.version);
}

/** Push an {@link UpdateStatus} to the tracked main window's renderer, mirroring how `navigation.ts` sends `navigate`. */
function sendUpdateStatus(status: UpdateStatus): void {
  lastStatus = foldForReplay(lastStatus, status);
  const win = getMainWindow?.();
  if (win && !win.isDestroyed()) win.webContents.send(UPDATE_STATUS_CHANNEL, status);
}

/** Show a message box anchored to the current main window, falling back to an unanchored dialog if none is tracked. */
function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const win = getMainWindow?.();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}
