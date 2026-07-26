import { app, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import log from 'electron-log';

/**
 * The one place the app decides it is really quitting.
 *
 * Everything funnels through Electron's `before-quit`: Cmd+Q, the menu, the
 * tray, the Dock, `autoUpdater.quitAndInstall()`, and the crash dialog's
 * "Quit". That makes it the only honest place to ask "are you sure?" — and the
 * only place that can guarantee the server is torn down before the process
 * goes.
 *
 * It also owns the answer to "is the app on its way out?", which
 * `server-crash-recovery.ts` needs so it does not flash a dialog over a quit
 * that is already winning. That used to be a second `before-quit` listener over
 * there, which was correct only while quitting was unconditional: now that a
 * quit can be **cancelled**, a module that latched on `before-quit` would
 * silently stop offering crash recovery for the rest of the session.
 */

/** Index of the leftmost (default) button in a `buttons` array. */
const PRIMARY_BUTTON = 0;

/** True from the moment the quit is committed to — after any confirmation, before the server is stopped. */
let quitting = false;

/** Whether {@link armQuitGuard} has already attached its listener. */
let armed = false;

/** Is the app on its way out? Read by crash recovery, which must stand down when it is. */
export function isQuitting(): boolean {
  return quitting;
}

/**
 * Clear the module's latched quit state.
 *
 * @internal Exported for testing only.
 */
export function resetQuitGuard(): void {
  quitting = false;
  armed = false;
  guardOptions = null;
}

/** Options for {@link armQuitGuard}. */
export interface QuitGuardOptions {
  /** How many agents are mid-run right now. */
  countActiveAgents: () => number;
  /** Point-in-time accessor for the window to anchor the confirmation to. */
  getWindow: () => BrowserWindow | null;
  /** Stop the server; resolves once it is gone. */
  shutdown: () => Promise<void>;
  /**
   * Whether this quit is an update restart, which asked its own question
   * already (see `auto-updater.ts`). Passed in rather than imported so this
   * module stays a leaf — `auto-updater.ts` imports
   * {@link confirmInterruptingAgents} from here.
   */
  isRestartingToUpdate: () => boolean;
}

/** The options {@link armQuitGuard} was given, for {@link confirmInterruptingAgents} to reuse. */
let guardOptions: QuitGuardOptions | null = null;

/**
 * Ask before interrupting agents that are mid-run. Resolves `true` when there
 * is nothing to interrupt, or when the person said to go ahead.
 *
 * Exported so the updater can ask **before** it arms the installer.
 * `autoUpdater.quitAndInstall()` closes every window and only then calls
 * `app.quit()`, so a question asked from `before-quit` on that path would
 * arrive with the windows already gone — and answering "Keep Working" would
 * leave a windowless app with a half-armed updater. Asking first costs nothing
 * to cancel.
 */
export async function confirmInterruptingAgents(): Promise<boolean> {
  if (!guardOptions) return true;
  const activeAgents = guardOptions.countActiveAgents();
  if (activeAgents === 0) return true;
  return confirmQuit(guardOptions.getWindow, activeAgents);
}

/**
 * Take ownership of quitting.
 *
 * Every quit is intercepted once: if agents are mid-run the person is asked
 * first, and only then is the server shut down and the quit let through. Call
 * once, before `ready`.
 *
 * This has to interplay correctly with `autoUpdater.quitAndInstall()`
 * (auto-updater.ts): it arms the native installer, then calls `app.quit()`.
 * That first quit hits `preventDefault()` and runs the sequence below, then the
 * `quitting` guard lets the second, explicit `quit()` through — so install +
 * relaunch only happens after the server has shut down cleanly.
 * `autoInstallOnAppQuit = true` is the fallback if `quitAndInstall()` is never
 * called directly. Do not "simplify" this dance without preserving it.
 *
 * @param options - See {@link QuitGuardOptions}.
 */
export function armQuitGuard(options: QuitGuardOptions): void {
  if (armed) return;
  armed = true;
  guardOptions = options;
  app.on('before-quit', (event: Electron.Event) => {
    // The second pass — our own `app.quit()` at the end of the sequence.
    if (quitting) return;
    // Electron does not await async `before-quit` handlers, so the quit is
    // stopped here and re-issued once the sequence finishes.
    event.preventDefault();
    void runQuitSequence(options);
  });
}

/**
 * Ask if anything is mid-run, stop the server, then quit for real.
 *
 * @param options - See {@link QuitGuardOptions}.
 */
async function runQuitSequence(options: QuitGuardOptions): Promise<void> {
  // An update restart already asked, back when there was still a window to ask
  // in front of. Asking again here would be a second dialog for one decision.
  if (!options.isRestartingToUpdate() && !(await confirmInterruptingAgents())) return;

  quitting = true;
  try {
    await options.shutdown();
  } catch (err) {
    // A server that will not shut down cleanly must not trap the person in an
    // app they asked to close; log it and go.
    log.error('[quit] The server did not shut down cleanly.', err);
  }
  app.quit();
}

/**
 * Ask before cutting agents off mid-run.
 *
 * Never shown when nothing is running — most quits are ordinary and deserve no
 * dialog at all. Staying is the default button and the Escape action, and both
 * options say plainly what they do.
 *
 * @param getWindow - Point-in-time accessor for the window to anchor to.
 * @param activeAgents - How many agents are mid-run.
 * @returns Whether the person confirmed the quit.
 */
async function confirmQuit(
  getWindow: () => BrowserWindow | null,
  activeAgents: number
): Promise<boolean> {
  const subject = activeAgents === 1 ? '1 agent is' : `${activeAgents} agents are`;
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Quit DorkOS?',
    message: `${subject} still working. Quit anyway?`,
    detail:
      'Quitting stops them where they are. To leave them running, close the window instead: ' +
      'DorkOS keeps going in the background and your agents carry on.',
    buttons: ['Keep Working', 'Quit Anyway'],
    defaultId: PRIMARY_BUTTON,
    cancelId: PRIMARY_BUTTON,
  };

  const win = getWindow();
  const { response } =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
  return response !== PRIMARY_BUTTON;
}
