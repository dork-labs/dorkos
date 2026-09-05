import { app, BrowserWindow, dialog } from 'electron';
import log from 'electron-log';
import { SERVER_READY_PARENT_TIMEOUT_MS } from '../shared/boot-timeouts';
import { chooseServerPort } from './server-port';
import { spawnServer, type ServerChild } from './server-spawn';
import { formatServerOutput } from './server-output';
import { recoverFromCrash } from './server-crash-recovery';
import { describeLogLocation } from './log-location';

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
 * When the current server reported itself ready, or `null` if none has.
 *
 * How long a server actually served is the difference between "it crashed" and
 * "it never worked" — see MIN_HEALTHY_UPTIME_MS in server-crash-recovery.
 */
let readySince: number | null = null;

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
 * Whether a {@link restartServer} cycle is between its stop and its start.
 *
 * A restart is not atomic — it stops a child, possibly deletes the data
 * directory, and starts a replacement — and two of them interleaved would have
 * one cycle's `startServer` race the other's `stopServer` over the same port and
 * the same SQLite store. Only one at a time, and the second caller is told so
 * rather than queued: the person clicked a button, and "already restarting" is
 * the honest answer to clicking it twice.
 */
let restarting = false;

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
 * Attach the child's own account of what went wrong to an error a person will
 * read.
 *
 * Without this the shell could only report an exit code, while the server's
 * actionable sentence — a data directory another process already holds, a
 * failed migration, a port it could not bind — sat in a log file nobody opens.
 * Verbatim, never parsed: the server owns the words, this side owns delivery.
 *
 * @param message - What the supervisor observed.
 * @param output - The child's stderr tail.
 */
function withServerOutput(message: string, output: string[]): Error {
  const reported = formatServerOutput(output);
  return new Error(reported ? `${message}\n\n${reported}` : message);
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
  readySince = null;
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
  // Read the child's last words before clearing it — clearChild drops the
  // reference that owns them.
  const output = child?.recentErrors() ?? [];
  const uptimeMs = readySince === null ? 0 : Date.now() - readySince;

  // Settle before clearing, so the specific reason wins over clearChild's
  // generic backstop. Always settle: clearing the timeout without rejecting
  // left `await startServer()` pending forever inside app.on('ready') — no
  // window, no error, nothing to do but force-quit. Asking about the
  // outstanding wait rather than the state also covers a quit that lands
  // mid-boot, where stopServer has already moved the state on to 'stopping'.
  if (wasStarting) {
    settleStart(
      withServerOutput(`The server exited with code ${code} before it was ready.`, output)
    );
  }
  clearChild();

  if (wasStarting || wasExpected) return;
  reportCrash(code, output, uptimeMs);
}

/**
 * Surface an unexpected server death and hand off to the recovery
 * conversation.
 *
 * @param code - The child's exit code, or `null` if it died from a signal.
 * @param output - The child's stderr tail, for the dialog to show.
 * @param uptimeMs - How long the dead server had been serving.
 */
function reportCrash(code: number | null, output: string[], uptimeMs: number): void {
  // Log first and unconditionally: this line is the only record that survives
  // when there is no window to show a dialog in.
  log.error(`[server] The server stopped unexpectedly (exit code ${code ?? 'none — signalled'}).`);
  void recoverFromCrash({
    code,
    output,
    uptimeMs,
    getWindow: () => getMainWindow?.() ?? null,
    restart: () => startServer(),
  }).catch((err: unknown) => {
    // The recovery conversation itself fell over — a rejected dialog, a
    // destroyed window mid-prompt. Without this it would be an unhandled
    // rejection: no message, no log, and an app pointing at a dead port.
    log.error('[server] Could not run crash recovery.', err);
    dialog.showErrorBox(
      "DorkOS couldn't recover its server",
      "DorkOS lost its background server and couldn't offer to start it again, so it can't " +
        'continue. Try opening DorkOS again. If this keeps happening, check ' +
        `${describeLogLocation()} for details.\n\n${err instanceof Error ? err.message : String(err)}`
    );
    app.quit();
  });
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
 * @returns The port number the server is listening on: the one someone pinned,
 *   or 4242 and the next free port after it when nobody has (see
 *   `server-port.ts`).
 * @throws If a server is already running; if a pinned port is unavailable or no
 *   port in the scanned range is free (a `PortUnavailableError`, which
 *   `index.ts` shows without its usual "try restarting" preamble); if the child
 *   cannot be spawned; or if it exits or stays silent before signalling
 *   readiness (within {@link SERVER_READY_PARENT_TIMEOUT_MS}).
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
    port = await chooseServerPort();
    child = spawnServer(port);
  } catch (err) {
    state = 'dead';
    throw err;
  }

  const started = child;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        settleStart(
          withServerOutput('The DorkOS server did not start in time.', started.recentErrors())
        ),
      SERVER_READY_PARENT_TIMEOUT_MS
    );
    pendingStart = { resolve, reject, timeout };

    started.on('message', (msg: unknown) => {
      if (isReadyMessage(msg)) settleStart(null);
    });
    // A spawn that never got off the ground (missing or unspawnable
    // executable) reports itself here, not through `exit`.
    started.on('error', (err: Error) => {
      settleStart(
        withServerOutput(
          `The DorkOS server could not be started: ${err.message}`,
          started.recentErrors()
        )
      );
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
  readySince = Date.now();
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
 * Safe to call twice: the quit sequence in `quit-guard.ts` and
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

/**
 * A restart that could not bring a server back.
 *
 * Carries {@link RestartFailedError.interrupted} because the two failures are
 * independent and a person needs both: the work asked for between the stop and
 * the start either happened or it did not, and that is a different question from
 * whether a server came back. Reporting only the second is how "was my data
 * deleted?" goes unanswered — the one question a reset must never leave open.
 */
export class RestartFailedError extends Error {
  /** What `whileStopped` threw before the start failed, or `null`. */
  readonly interrupted: Error | null;

  /**
   * Wrap a failed start, keeping both accounts of what went wrong.
   *
   * @param cause - Whatever {@link startServer} rejected with. Its message is
   *   adopted verbatim, because it is the server's own account of why it did not
   *   come up, and the original rides along as `cause`.
   * @param interrupted - What `whileStopped` threw, or `null`.
   */
  constructor(cause: unknown, interrupted: Error | null) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RestartFailedError';
    this.interrupted = interrupted;
  }
}

/** What a {@link restartServer} cycle ended with. */
export interface RestartOutcome {
  /** The port the replacement server is listening on. */
  port: number;
  /**
   * What `whileStopped` threw, or `null` when it ran cleanly (or was not given).
   *
   * Reported rather than thrown because the server was started anyway — see
   * {@link restartServer}. A caller that has nothing to do between the stop and
   * the start can ignore this; the one that deletes the data directory reads it
   * to find out whether the deletion happened.
   */
  interrupted: Error | null;
}

/**
 * Stop the running server and start a replacement, optionally doing something
 * while nothing is holding the data directory.
 *
 * This is what makes Settings → Advanced work in the desktop app (DOR-542).
 * `POST /api/admin/restart` cannot: it re-execs `process.argv[0]`, which inside
 * an Electron `UtilityProcess` is the app executable rather than Node, so the
 * server exited and nothing came back — which is why the server refuses that
 * route outright when a supervisor owns its lifecycle (`DORKOS_MANAGED_BY`).
 * The supervisor, on the other hand, restarts its own child by definition.
 *
 * **This function always ends with a server running, or it throws.** That is the
 * whole contract, and it is why `whileStopped` failing is *reported* instead of
 * propagated: a callback that threw between the stop and the start would
 * otherwise leave the app with no server and no port — the exact bricking DOR-532
 * gated the HTTP route to prevent, reintroduced one process up.
 *
 * @param whileStopped - Run once the old child is gone and before the new one
 *   is spawned, which is the only moment nothing holds the data directory.
 * @returns The new port, and whatever `whileStopped` threw.
 * @throws A plain `Error` if a restart is already running — nothing was touched,
 *   and the message is a finished sentence for the person who asked twice. A
 *   {@link RestartFailedError} if the replacement server could not be started
 *   (see {@link startServer} for the ways that happens); it carries what
 *   `whileStopped` threw as well, because by then BOTH halves may have failed
 *   and a caller that reported only the start would leave "did my data get
 *   deleted?" unanswered. Either way the caller is left with no server — and,
 *   because this path is IPC rather than HTTP, with a button that still works to
 *   try again.
 */
export async function restartServer(whileStopped?: () => Promise<void>): Promise<RestartOutcome> {
  if (restarting) {
    throw new Error('DorkOS is already restarting its server. Give it a moment.');
  }
  restarting = true;
  try {
    await stopServer();

    let interrupted: Error | null = null;
    if (whileStopped) {
      try {
        await whileStopped();
      } catch (err) {
        interrupted = err instanceof Error ? err : new Error(String(err));
      }
    }

    try {
      return { port: await startServer(), interrupted };
    } catch (err) {
      throw new RestartFailedError(err, interrupted);
    }
  } finally {
    restarting = false;
  }
}

/** The port the server is listening on, or `null` when no server is running. */
export function getServerPort(): number | null {
  return serverPort;
}
