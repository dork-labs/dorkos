import { app, BrowserWindow, dialog } from 'electron';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import log from 'electron-log';
import { SERVER_READY_PARENT_TIMEOUT_MS } from '../shared/boot-timeouts';
import { getFreePort, spawnServer, type ServerChild } from './server-spawn';

/**
 * Supervisor for the Express server the desktop shell runs as a child process.
 *
 * Everything about the child's liveness lives in one place here, because the
 * previous arrangement inferred it three different ways — a `child` reference,
 * a `serverPort` copy, and an exit-code heuristic — and the three disagreed.
 * A server that exited 0 (which is exactly what `POST /api/admin/restart` and
 * "Reset All Data" do) was silently ignored: no dialog, no log, and
 * `getServerPort()` kept handing the renderer a dead port.
 *
 * The replacement is a small state machine. {@link ServerState} says what the
 * child is doing, {@link expectedExit} says whether we asked for the exit that
 * is happening, and a single `exit` listener routes every death through
 * {@link handleExit}. Every unexpected exit is a crash, whatever its code.
 */

/** How long a graceful shutdown gets before the child is killed outright. */
const SHUTDOWN_GRACE_MS = 5_000;

/** Index of "Restart Server" in the crash dialog's `buttons` array. */
const RESTART_BUTTON = 0;

/**
 * What the supervised child is doing.
 *
 * - `starting` — spawned, waiting for its `ready` message.
 * - `ready` — serving on {@link serverPort}.
 * - `stopping` — sent `shutdown`, waiting for it to exit.
 * - `dead` — no child. The only state {@link startServer} may be called from.
 */
type ServerState = 'starting' | 'ready' | 'stopping' | 'dead';

let state: ServerState = 'dead';
let child: ServerChild | null = null;
let serverPort: number | null = null;

/**
 * Whether the exit we are about to see is one we asked for. Set *only* by
 * {@link stopServer} and cleared by {@link handleExit}, so "did the user quit,
 * or did the server die?" is a recorded fact rather than something each
 * consumer re-derives from an exit code.
 */
let expectedExit = false;

/** Point-in-time accessor for the main window, stored the way `setupAutoUpdater` stores its own. */
let getMainWindow: (() => BrowserWindow | null) | null = null;

/** The in-flight `startServer` readiness wait, or `null` when not starting. */
let pendingStart: {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
} | null = null;

/** Callbacks waiting on the current child's exit (see {@link stopServer}). */
const exitWaiters = new Set<() => void>();

/** Guard so repeated `startServer` calls don't stack process-level listeners. */
let safetyNetInstalled = false;

/**
 * Log promise rejections nothing else handled.
 *
 * Electron's main process has no default handler for these, so before this a
 * rejection had nowhere to land: no dialog, no log line, nothing in
 * `~/Library/Logs`. The crash-restart path below was the concrete case — but
 * the net is deliberately process-wide, because the whole main process is
 * event handlers whose promises nobody awaits.
 *
 * Know what registering this changes, because it is not local to this module.
 * Node's default for an unhandled rejection is to raise it as an uncaught
 * exception and terminate; **any** listener replaces that with "call the
 * listener and keep going". So from here on, every unawaited rejection
 * anywhere in the main process is survivable and shows up only as a log line.
 * That is the right trade for a desktop shell — a stray rejection in one
 * handler should not take the user's windows and running agents down with it —
 * but it does mean the log is now the only place such a bug surfaces.
 */
function installSafetyNet(): void {
  if (safetyNetInstalled) return;
  safetyNetInstalled = true;
  process.on('unhandledRejection', (reason: unknown) => {
    log.error(
      'Unhandled promise rejection in the main process:',
      reason instanceof Error ? reason : new Error(String(reason))
    );
  });
}

/**
 * The window to anchor a dialog to: the tracked main window when there is a
 * live one, else whatever happens to be focused, else `null`.
 *
 * `null` is a normal outcome, not a failure — Electron shows an unanchored
 * message box just fine. The old code looked up `getFocusedWindow()` and
 * skipped the *entire* crash handler when it came back `null`, which is what
 * happens whenever the app isn't frontmost: the single most likely moment for
 * a server crash to go unnoticed.
 */
function resolveDialogWindow(): BrowserWindow | null {
  const tracked = getMainWindow?.() ?? null;
  if (tracked && !tracked.isDestroyed()) return tracked;
  return BrowserWindow.getFocusedWindow();
}

/** Show a message box anchored to the current main window, unanchored if there is none. */
function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const win = resolveDialogWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/**
 * Settle the in-flight readiness wait exactly once, whichever way it went, and
 * drop its timeout. A no-op after the first call, so a child that reports
 * ready and then dies during the same turn doesn't settle twice.
 *
 * @param err - The failure to reject with, or `null` for a successful start.
 */
function settleStart(err: Error | null): void {
  const pending = pendingStart;
  if (!pending) return;
  pendingStart = null;
  clearTimeout(pending.timeout);
  if (err) pending.reject(err);
  else pending.resolve();
}

/**
 * Clear every trace of the current child. Idempotent.
 *
 * Settling any outstanding startup wait is part of "every trace": once there
 * is no child, nothing will ever arrive to settle it. This is the backstop for
 * the path {@link stopServer} takes when it gives up and kills a child that
 * never exited — the identity guard on the `exit` listener means that child's
 * eventual exit is ignored, so {@link handleExit} is not coming.
 */
function clearChild(): void {
  child = null;
  serverPort = null;
  state = 'dead';
  expectedExit = false;
  settleStart(new Error('The DorkOS server was stopped before it finished starting.'));
  for (const waiter of [...exitWaiters]) waiter();
  exitWaiters.clear();
}

/**
 * The single `exit` listener. Routes by what the supervisor was doing, so the
 * same event means "startup failed", "we asked for this", or "it crashed"
 * without anyone re-reading the exit code to guess which.
 *
 * @param code - Exit code, or `null` when the process died from a signal
 *   (a segfaulting native module, `kill -9`) — just as unexpected as any
 *   non-zero code, and previously ignored alongside it.
 */
function handleExit(code: number | null): void {
  const wasExpected = expectedExit;
  const wasStarting = pendingStart !== null;

  // Settle before clearing, so the specific reason wins over clearChild's
  // generic backstop. Always settle: clearing the timeout without rejecting
  // left `await startServer()` pending forever inside app.on('ready') — no
  // window, no error, nothing to do but force-quit. Asking about the
  // outstanding wait rather than the state also covers a quit that lands
  // mid-boot, where stopServer has already moved the state on to 'stopping'.
  if (wasStarting) {
    settleStart(new Error(`The server exited with code ${code} before it was ready.`));
  }
  clearChild();

  if (wasStarting || wasExpected) return;
  reportCrash(code);
}

/**
 * Surface an unexpected server death and offer to restart.
 *
 * @param code - The child's exit code, or `null` if it died from a signal.
 */
function reportCrash(code: number | null): void {
  // Log first and unconditionally: this line is the only record that survives
  // when there is no window to show a dialog in.
  log.error(`[server] The server stopped unexpectedly (exit code ${code ?? 'none — signalled'}).`);
  void offerRestart(code);
}

/**
 * Ask the user whether to restart the server or quit, and carry out the answer.
 *
 * @param code - The child's exit code, for the dialog's detail line.
 */
async function offerRestart(code: number | null): Promise<void> {
  try {
    const { response } = await showMessageBox({
      type: 'error',
      title: 'Server Error',
      message: 'The DorkOS server stopped unexpectedly.',
      detail:
        'Your work is saved. Start the server again to pick up where you left off, or quit ' +
        `DorkOS.\n\nExit code: ${code ?? 'none (the server was stopped by a signal)'}`,
      buttons: ['Restart Server', 'Quit'],
    });
    if (response !== RESTART_BUTTON) {
      app.quit();
      return;
    }
    const newPort = await startServer();
    pointWindowAtServer(newPort);
  } catch (err) {
    // A failed restart used to become an unhandled rejection: no second
    // dialog, no log line, and an app still pointing at a dead port.
    log.error('[server] Restarting the server failed.', err);
    dialog.showErrorBox(
      "DorkOS couldn't restart its server",
      "DorkOS tried to start its background server again and couldn't, so it can't continue. " +
        'Try opening DorkOS again. If this keeps happening, check ~/Library/Logs/DorkOS for ' +
        `details.\n\n${err instanceof Error ? err.message : String(err)}`
    );
    app.quit();
  }
}

/**
 * Point the main window at a freshly restarted server, whose port is new.
 *
 * @param port - The port the replacement server is listening on.
 */
function pointWindowAtServer(port: number): void {
  const win = resolveDialogWindow();
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
 * Start the Express server in an isolated process and wait for it to report
 * itself ready.
 *
 * Once ready, the child is supervised: any exit that {@link stopServer} did
 * not ask for is treated as a crash, whatever its exit code.
 *
 * @param mainWindowAccessor - Point-in-time accessor for the current main
 *   window, used to anchor the crash dialog. Stored for the lifetime of the
 *   process, so a restart from that dialog keeps using it.
 * @returns The port number the server is listening on.
 * @throws If a server is already running, if the child cannot be spawned, or
 *   if it exits or stays silent before signalling readiness (within
 *   {@link SERVER_READY_PARENT_TIMEOUT_MS}).
 */
export async function startServer(
  mainWindowAccessor?: () => BrowserWindow | null
): Promise<number> {
  installSafetyNet();
  if (mainWindowAccessor) getMainWindow = mainWindowAccessor;
  if (state !== 'dead') {
    throw new Error(`Cannot start a second DorkOS server: the current one is ${state}.`);
  }

  // Claim the supervisor before the first await, so two overlapping calls
  // can't both get past the guard while a port is being probed.
  state = 'starting';
  expectedExit = false;
  let port: number;
  try {
    port = await getFreePort();
    child = spawnServer(port);
  } catch (err) {
    state = 'dead';
    throw err;
  }

  const started = child;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => settleStart(new Error('The DorkOS server did not start in time.')),
      SERVER_READY_PARENT_TIMEOUT_MS
    );
    pendingStart = { resolve, reject, timeout };

    started.on('message', (msg: unknown) => {
      if (isReadyMessage(msg)) settleStart(null);
    });
    // A spawn that never got off the ground (missing or unspawnable
    // executable) reports itself here, not through `exit`.
    started.on('error', (err: Error) => {
      settleStart(new Error(`The DorkOS server could not be started: ${err.message}`));
    });
    // The one exit listener, for this child's whole life: it settles startup
    // now and reports crashes later (see handleExit). Guarded on identity so
    // a child we already gave up on and killed cannot, on its way out, be
    // mistaken for a crash of its replacement.
    started.on('exit', (code: number | null) => {
      if (child === started) handleExit(code);
    });
  }).catch((err: unknown) => {
    // Leave nothing behind: a half-started child would keep the port, the
    // SQLite lock, and any agent sessions it already opened.
    if (child === started) {
      started.kill();
      clearChild();
    }
    throw err;
  });

  state = 'ready';
  serverPort = port;
  return port;
}

/** Is this the child's "I'm serving" handshake message? */
function isReadyMessage(msg: unknown): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type: unknown }).type === 'ready'
  );
}

/**
 * Stop the server process, gracefully if it cooperates.
 *
 * Returns as soon as the child is gone. When it has already exited — after a
 * crash, or a previous call — there is nothing to wait for and this resolves
 * immediately; it used to sit out the full grace period listening for an
 * `exit` event from a process that had already exited, which made Cmd+Q
 * visibly hang after any server death.
 *
 * Safe to call twice: `index.ts`'s `before-quit` handler and
 * `autoUpdater.quitAndInstall()` can both reach it.
 */
export async function stopServer(): Promise<void> {
  const stopping = child;
  if (!stopping) return;

  if (state !== 'stopping') {
    expectedExit = true;
    state = 'stopping';
    try {
      stopping.send({ type: 'shutdown' });
    } catch (err) {
      // Sending to a child that already died emits an `error` event, which
      // throws with no listener attached. Nothing left to ask nicely.
      log.warn('[server] Could not deliver the shutdown message; killing the server.', err);
      stopping.kill();
    }
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      log.warn(`[server] The server ignored shutdown for ${SHUTDOWN_GRACE_MS}ms; killing it.`);
      stopping.kill();
      exitWaiters.delete(onExit);
      resolve();
    }, SHUTDOWN_GRACE_MS);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    exitWaiters.add(onExit);
  });

  // A killed child that never emitted `exit` still has to stop being the
  // current one, or the next startServer would refuse to run.
  if (child === stopping) clearChild();
}

/** The port the server is listening on, or `null` when no server is running. */
export function getServerPort(): number | null {
  return serverPort;
}
