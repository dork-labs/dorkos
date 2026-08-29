import { app, BrowserWindow, dialog, shell } from 'electron';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import log from 'electron-log';
import { formatServerOutput } from './server-output';
import { isQuitting } from './quit-guard';

/**
 * What the desktop shell does about a server it did not expect to lose:
 * tell the user what happened in the server's own words, offer to start it
 * again, and know when to stop offering.
 *
 * Split from `server-process.ts` because supervising a process and running a
 * recovery conversation with a person are different jobs, and only one of them
 * involves dialogs.
 */

/**
 * How many restarts may fail in a row before the retry button is withdrawn.
 *
 * Some failures cannot be retried out of. A `dorkos` CLI server already
 * holding the data directory is the case that prompted this: every restart
 * refuses for the same reason, so an unlimited "Restart Server" button is a
 * button that can never succeed. Three attempts is enough to ride out
 * something transient and few enough that the user is not clicking into a wall.
 */
const MAX_RESTART_FAILURES = 3;

/**
 * How long a server must stay up before it counts as having actually worked.
 *
 * Spawning successfully is not the same thing as staying up, and the difference
 * is the whole point of this counter. A server that boots and dies seconds
 * later — the renderer reloads onto the new port and re-issues the request that
 * killed it, an OOM, a faulting native module — would otherwise reset the
 * counter on every cycle and loop forever, which is the exact behaviour the cap
 * exists to stop. A minute of service is a working server; anything shorter is
 * another failure.
 */
const MIN_HEALTHY_UPTIME_MS = 60_000;

/** Index of the leftmost (default) button in a `buttons` array. */
const PRIMARY_BUTTON = 0;

/** Restarts that have not produced a server that stayed up. */
let consecutiveFailures = 0;

/**
 * Whether the app is on its way out — asked of `quit-guard.ts`, which owns it.
 *
 * Cmd+Q during a still-booting restart tears the child down, which surfaces as
 * a failed restart; without standing down, the shell would flash a dialog on
 * the way out, over an `app.quit()` that is already winning. This used to be a
 * `before-quit` listener of its own, which latched the moment the event fired.
 * That was safe only while a quit could not be cancelled — now that quitting
 * with agents mid-run asks first, a latched flag would silently disable crash
 * recovery for the rest of the session when someone said "keep working".
 */

/** Options for {@link recoverFromCrash}. */
export interface CrashRecoveryOptions {
  /** The dead child's exit code, or `null` if it was killed by a signal. */
  code: number | null;
  /** The child's last stderr lines — its own account of why it died. */
  output: string[];
  /** How long the dead server had been serving, in ms. */
  uptimeMs: number;
  /** Point-in-time accessor for the main window, to anchor dialogs to. */
  getWindow: () => BrowserWindow | null;
  /** Start a replacement server; resolves with the port it listens on. */
  restart: () => Promise<number>;
}

/**
 * Tell the user the server died and act on what they choose.
 *
 * Loops rather than returning after one attempt, because a failed restart is
 * itself something the user has to decide about — but only up to
 * {@link MAX_RESTART_FAILURES}, after which the retry is withdrawn and the
 * choice becomes "look at the logs" or "quit".
 *
 * @param options - See {@link CrashRecoveryOptions}.
 */
export async function recoverFromCrash(options: CrashRecoveryOptions): Promise<void> {
  const { code, output, uptimeMs, getWindow, restart } = options;

  // Account for the server that just died before deciding anything. One that
  // served for a while was genuinely working, so this is a fresh incident; one
  // that died almost immediately is another failure, whether or not it managed
  // to start.
  if (uptimeMs >= MIN_HEALTHY_UPTIME_MS) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures += 1;
  }

  let detail = crashDetail(code, output);

  for (;;) {
    if (isQuitting()) return;
    if (consecutiveFailures >= MAX_RESTART_FAILURES) {
      await giveUp(getWindow, detail);
      return;
    }

    const { response } = await ask(getWindow, {
      type: 'error',
      title: 'Server Error',
      message: 'The DorkOS server stopped unexpectedly.',
      detail,
      buttons: ['Restart Server', 'Quit'],
    });
    if (response !== PRIMARY_BUTTON) {
      app.quit();
      return;
    }

    try {
      pointWindowsAtServer(await restart());
      return;
    } catch (err) {
      consecutiveFailures += 1;
      log.error('[server] Restarting the server failed.', err);
      // The error already carries the child's own words (server-process
      // attaches them), so it is shown as-is rather than rewritten.
      detail = err instanceof Error ? err.message : String(err);
    }
  }
}

/**
 * Stop offering something that keeps not working, and point at the logs.
 *
 * @param getWindow - Accessor for the window to anchor to.
 * @param detail - Why the last attempt failed, in the server's own words.
 */
async function giveUp(getWindow: () => BrowserWindow | null, detail: string): Promise<void> {
  const { response } = await ask(getWindow, {
    type: 'error',
    title: 'Server Error',
    message: `DorkOS tried ${MAX_RESTART_FAILURES} times to get its server running, and it did not stay up.`,
    detail: [detail, 'The full story is in the logs.'].filter(Boolean).join('\n\n'),
    buttons: ['Open Logs', 'Quit'],
  });
  if (response === PRIMARY_BUTTON) revealLogs();
  app.quit();
}

/**
 * What to tell the user about a crash: the server's own account first, because
 * that is the part that says what to do about it.
 *
 * @param code - Exit code, or `null` for death by signal.
 * @param output - The child's stderr tail.
 */
function crashDetail(code: number | null, output: string[]): string {
  return [
    formatServerOutput(output),
    'Your work is saved. Start the server again to pick up where you left off, or quit DorkOS.',
    `Exit code: ${code ?? 'none (the server was stopped by a signal)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Reveal the app's log file in the OS file manager. Best-effort. */
function revealLogs(): void {
  try {
    shell.showItemInFolder(log.transports.file.getFile().path);
  } catch (err) {
    log.error('[server] Could not reveal the log file.', err);
  }
}

/**
 * Point every cockpit window at the freshly restarted server.
 *
 * Unconditional, and not an optimisation to skip when the port came back the
 * same (which it usually does now — see `server-port.ts`): the window is
 * holding a connection to a process that no longer exists, so it has to be sent
 * back to the address whatever that address turned out to be.
 *
 * All of them, not just the tracked one: a second window opened with
 * `window.open` is a full cockpit on the same origin, and leaving it pointed at
 * a dead server would strand it with no way to recover but closing it.
 *
 * Shared with the updater's stalled-restart recovery (`auto-updater.ts`), which
 * brings the same server back up for a different reason and leaves the same
 * windows pointed at a port that is gone.
 *
 * @param port - The port the replacement server is listening on.
 */
export function pointWindowsAtServer(port: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // A packaged build loads the renderer *from* the server, so it has to move
    // to the new origin. In dev the renderer comes from electron-vite and only
    // needs a reload, which re-reads the port over IPC — navigating it to the
    // server would strand it away from the dev server.
    if (app.isPackaged) {
      void win.loadURL(`http://localhost:${port}`);
    } else {
      win.reload();
    }
  }
}

/**
 * The window to anchor a dialog to: the tracked main window when there is a
 * live one, else whatever happens to be focused, else `null`.
 *
 * `null` is a normal outcome, not a failure — Electron shows an unanchored
 * message box just fine. The original code looked up `getFocusedWindow()` and
 * skipped the *entire* crash handler when it came back `null`, which is what
 * happens whenever the app isn't frontmost: the single most likely moment for
 * a server crash to go unnoticed.
 *
 * @param getWindow - Point-in-time accessor for the tracked main window.
 */
function resolveDialogWindow(getWindow: () => BrowserWindow | null): BrowserWindow | null {
  const tracked = getWindow();
  if (tracked && !tracked.isDestroyed()) return tracked;
  return BrowserWindow.getFocusedWindow();
}

/**
 * Show a message box anchored to the current main window, unanchored if there
 * is none.
 *
 * @param getWindow - Point-in-time accessor for the tracked main window.
 * @param options - The message box to show.
 */
function ask(
  getWindow: () => BrowserWindow | null,
  options: MessageBoxOptions
): Promise<MessageBoxReturnValue> {
  const win = resolveDialogWindow(getWindow);
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}
