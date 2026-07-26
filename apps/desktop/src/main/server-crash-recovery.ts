import { app, BrowserWindow, dialog, shell } from 'electron';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import log from 'electron-log';
import { formatServerOutput } from './server-output';

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

/** Index of the leftmost (default) button in a `buttons` array. */
const PRIMARY_BUTTON = 0;

/** Restarts that have failed since the last time a server successfully started. */
let consecutiveFailures = 0;

/** Options for {@link recoverFromCrash}. */
export interface CrashRecoveryOptions {
  /** The dead child's exit code, or `null` if it was killed by a signal. */
  code: number | null;
  /** The child's last stderr lines — its own account of why it died. */
  output: string[];
  /** Point-in-time accessor for the main window, to anchor dialogs to. */
  getWindow: () => BrowserWindow | null;
  /** Start a replacement server; resolves with the port it listens on. */
  restart: () => Promise<number>;
}

/**
 * Forget the failure history.
 *
 * Called by `startServer` on every successful start, so "consecutive" means
 * what it says: a restart that works clears the slate for the next incident.
 */
export function resetRestartFailures(): void {
  consecutiveFailures = 0;
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
  const { code, output, getWindow, restart } = options;
  let detail = crashDetail(code, output);

  for (;;) {
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
      pointWindowAtServer(getWindow, await restart());
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
    message: `DorkOS tried ${MAX_RESTART_FAILURES} times to start its server, and it did not come back.`,
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
 * Point the main window at a freshly restarted server, whose port is new.
 *
 * @param getWindow - Accessor for the window to move.
 * @param port - The port the replacement server is listening on.
 */
function pointWindowAtServer(getWindow: () => BrowserWindow | null, port: number): void {
  const win = resolveDialogWindow(getWindow);
  if (!win || win.isDestroyed()) return;
  // A packaged build loads the renderer *from* the server, so it has to move
  // to the new origin. In dev the renderer comes from electron-vite and only
  // needs a reload, which re-reads the port over IPC — navigating it to the
  // server would strand it away from the dev server.
  if (app.isPackaged) {
    win.loadURL(`http://localhost:${port}`);
  } else {
    win.reload();
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
