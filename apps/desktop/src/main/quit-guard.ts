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

/** True when the next quit has already been answered for and must not be questioned. */
let preconfirmed = false;

/**
 * Declare that the quit about to happen was already confirmed by the person,
 * so this guard does not ask a second time.
 *
 * For quits the app *causes* on the back of an answer it already holds. The
 * move into Applications is the first (`install-location/`): the person
 * confirmed it, Electron quits and relaunches to finish it, and a question over
 * that would be a second dialog for one decision — worse, a declined one would
 * strand the relauncher waiting on a process that never exits.
 *
 * Arm it **before** the call that quits, not after: those APIs can quit from
 * inside themselves, and a confirmation set afterwards arrives too late to be
 * seen. Withdraw it with {@link cancelPreconfirmedQuit} on any path that turns
 * out not to quit, or it silently disarms the agent question for the rest of
 * the session.
 */
export function preconfirmQuit(): void {
  preconfirmed = true;
}

/** Withdraw a {@link preconfirmQuit} whose quit did not happen after all. */
export function cancelPreconfirmedQuit(): void {
  preconfirmed = false;
}

/**
 * Take the pre-confirmation, if there is one.
 *
 * Spent on read for the same reason the updater's restart confirmation is,
 * though here that is belt-and-braces rather than the load-bearing half: the
 * `quitting` latch means no second quit sequence ever runs in one process, so
 * {@link cancelPreconfirmedQuit} is what actually keeps a confirmation from
 * outliving the quit it was given for.
 */
function consumePreconfirmedQuit(): boolean {
  const wasPreconfirmed = preconfirmed;
  preconfirmed = false;
  return wasPreconfirmed;
}

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
  preconfirmed = false;
  guardOptions = null;
}

/** What the person is about to do to the agents that are running. */
export type QuitIntent = 'quit' | 'restart';

/** Options for {@link armQuitGuard}. */
export interface QuitGuardOptions {
  /** How many agents are mid-run right now. */
  countActiveAgents: () => number;
  /** Point-in-time accessor for the window to anchor the confirmation to. */
  getWindow: () => BrowserWindow | null;
  /** Stop the server; resolves once it is gone. */
  shutdown: () => Promise<void>;
  /**
   * Take the person's restart confirmation, if it is still good: `true` means
   * this quit is an update restart they already answered for, and that the
   * server has already been stopped for it (see `auto-updater.ts`) — so the
   * quit is let through untouched rather than intercepted.
   *
   * It is their authorisation, not a flag, so it decays like one. **Reading it
   * spends it**, and it expires on its own after about ten minutes if the
   * restart it was given for never arrives. Both matter: the spend covers a
   * restart that quits, the expiry covers one that silently does not. So a
   * quit shortly after a restart attempt that has not landed yet *is* still
   * let straight through — correctly, because that restart already took the
   * server down and answered the question.
   *
   * Passed in rather than imported so this module stays a leaf;
   * `auto-updater.ts` imports {@link confirmInterruptingAgents} from here.
   */
  consumeUpdateRestart: () => boolean;
  /**
   * Write down that an update is about to be installed by this quit, so the
   * next launch can tell whether it actually was (see `auto-updater.ts`).
   *
   * Wired here because **an ordinary quit installs updates too**
   * (`autoInstallOnAppQuit`), and that path never passes through the restart
   * button — it is how the reporting user's one successful install finally
   * happened, unannounced. A no-op when nothing is staged, and idempotent, so
   * the restart path calling it first costs nothing. Called on both branches of
   * the handler for that reason: every quit that installs is recorded, whether
   * or not it was the installer that started it.
   */
  recordUpdateInstallIntent: () => void;
}

/** The options {@link armQuitGuard} was given, for {@link confirmInterruptingAgents} to reuse. */
let guardOptions: QuitGuardOptions | null = null;

/**
 * Ask before interrupting agents that are mid-run. Resolves `true` when there
 * is nothing to interrupt, or when the person said to go ahead.
 *
 * Exported so the updater can ask **before** it arms the installer.
 * `quitAndInstall()` is not cancellable in any useful sense once called: on
 * Windows it has already run the installer by the time it quits, and on macOS
 * it may hand off to Squirrel and take the windows with it. A question asked
 * from `before-quit` on that path would arrive too late to act on. Asking
 * first costs nothing to cancel.
 *
 * @param intent - What is about to happen, which decides the wording. A restart
 *   is not a quit, and telling someone who clicked "Restart to install" to
 *   "close the window instead" is advice that does not install their update.
 */
export async function confirmInterruptingAgents(intent: QuitIntent = 'quit'): Promise<boolean> {
  if (!guardOptions) return true;
  const activeAgents = guardOptions.countActiveAgents();
  if (activeAgents === 0) return true;
  return confirmQuit(guardOptions.getWindow, activeAgents, intent);
}

/**
 * Take ownership of quitting.
 *
 * An ordinary quit is intercepted once: if agents are mid-run the person is
 * asked first, and only then is the server shut down and the quit let through.
 * Call once, before `ready`.
 *
 * **The installer's quit is the one quit this must not touch.** An update
 * restart has already asked the person, recorded the attempt and stopped the
 * server by the time it gets here (`prepareUpdateRestart` in
 * `auto-updater.ts`), so there is nothing left for the sequence to do — and
 * doing it anyway is the prime suspect for ten days of updates that quit and
 * came back on the old version. `preventDefault()` cancels the termination
 * Squirrel armed its install against, and the plain `app.quit()` issued in its
 * place is a different quit (`plans/desktop-resilience-program.md` §2B).
 * `autoInstallOnAppQuit = true` covers the ordinary quit, which still runs the
 * full sequence below. Do not "simplify" this split without preserving it.
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
    if (options.consumeUpdateRestart()) {
      // Committed, and correctly so: nothing below this line can stop the quit,
      // because nothing prevented it. Crash recovery reads `isQuitting()` and
      // has to stand down.
      quitting = true;
      // Belt and braces. The restart path writes this itself, and the write is
      // idempotent per run, so this costs nothing there — it stands here so
      // "a quit that installs something is on record" holds however the
      // restart came to be armed.
      options.recordUpdateInstallIntent();
      log.info('[quit] Letting the installer quit the app; the server is already down.');
      return;
    }
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
  // An update restart never reaches here — the listener above lets it straight
  // through without preventDefault. A quit the app itself caused on the back
  // of an answer it already holds (see {@link preconfirmQuit}) DOES reach
  // here, and that answer was given back when it could still change anything —
  // asking again would be a second dialog for one decision. Spent on read so
  // it can never carry into a later, unrelated quit.
  const quitPreconfirmed = consumePreconfirmedQuit();
  if (!quitPreconfirmed && !(await confirmInterruptingAgents())) return;

  quitting = true;
  try {
    // Before the shutdown, not after: a server that hangs on the way down must
    // not cost us the record of what this quit was about to install. Inside
    // the try for the same reason the shutdown is — past `quitting = true`,
    // anything that throws on the way out strands the app in a state where the
    // NEXT quit skips the shutdown entirely.
    options.recordUpdateInstallIntent();
    await options.shutdown();
  } catch (err) {
    // A quit that will not complete cleanly must not trap the person in an app
    // they asked to close; log it and go.
    log.error('[quit] The quit sequence did not complete cleanly.', err);
  }
  app.quit();
}

/** What to say for each way of interrupting agents. The verb has to match the button. */
const INTENT_COPY: Record<QuitIntent, { title: string; verb: string; confirm: string }> = {
  quit: { title: 'Quit DorkOS?', verb: 'Quit', confirm: 'Quit Anyway' },
  restart: { title: 'Restart to Update?', verb: 'Restart', confirm: 'Restart Anyway' },
};

/**
 * How to say "leave them running", which depends on what is still on screen.
 *
 * A quit asked with a window open can point at the window. Asked without one —
 * the last window has already closed, on a platform where the tray could not be
 * created — "close the window instead" is advice about a window that is not
 * there. What is true then is that the agents keep going and launching DorkOS
 * again brings the window back: the second launch fails the single-instance
 * lock, and `second-instance` routes it to `showMainWindow` (see `index.ts`).
 *
 * @param intent - What is about to happen.
 * @param hasWindow - Whether there is a live window to point at.
 */
function detailFor(intent: QuitIntent, hasWindow: boolean): string {
  if (intent === 'restart') {
    // Never "close the window instead" here: on the native branch this dialog
    // only ever runs when there is no window, and closing one would not install
    // the update they just asked for. What is true is that declining costs them
    // nothing, because the update lands on the next quit anyway
    // (`autoInstallOnAppQuit`, set in setupAutoUpdater).
    return (
      'Restarting installs the update and stops them where they are. To let them finish, ' +
      'choose Keep Working: the update is applied the next time you quit DorkOS.'
    );
  }
  if (hasWindow) {
    return (
      'Quitting stops them where they are. To leave them running, close the window instead: ' +
      'DorkOS keeps going in the background and your agents carry on.'
    );
  }
  return (
    'Quitting stops them where they are. To leave them running, choose Keep Working: ' +
    'DorkOS keeps going in the background, and opening DorkOS again brings the window back.'
  );
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
 * @param intent - What is about to happen; see {@link INTENT_COPY} and
 *   {@link detailFor}.
 * @returns Whether the person confirmed.
 */
async function confirmQuit(
  getWindow: () => BrowserWindow | null,
  activeAgents: number,
  intent: QuitIntent
): Promise<boolean> {
  const subject = activeAgents === 1 ? '1 agent is' : `${activeAgents} agents are`;
  const copy = INTENT_COPY[intent];
  const win = getWindow();
  const hasWindow = win !== null && !win.isDestroyed();
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: copy.title,
    // `activeAgents` is streaming AND blocked combined (see agent-activity.ts)
    // — a session paused on an approval is not "working" in the sense a
    // reader hears that word, so the dialog says both rather than the one
    // that happens to be true for some of the count and not the rest.
    message: `${subject} still working or waiting on your answer. ${copy.verb} anyway?`,
    detail: detailFor(intent, hasWindow),
    buttons: ['Keep Working', copy.confirm],
    defaultId: PRIMARY_BUTTON,
    cancelId: PRIMARY_BUTTON,
  };

  const { response } = hasWindow
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response !== PRIMARY_BUTTON;
}
