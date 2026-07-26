import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import type { MockServerProcess } from './server-child-mock';
import { SERVER_READY_PARENT_TIMEOUT_MS } from '../../shared/boot-timeouts';

/**
 * Mirrors `SHUTDOWN_GRACE_MS` in `server-process.ts`. Not imported: it is an
 * internal policy value with no reason to be exported, and the tests that use
 * it are asserting on that exact policy.
 */
const SHUTDOWN_GRACE_MS = 5_000;

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * `vi.mock(..., factory)` memoizes its result for the whole test file, so mock
 * state is fetched through the real specifier (matching `index.test.ts` and
 * `auto-updater.test.ts`) rather than importing the mock modules directly —
 * `vi.resetModules()` re-evaluates the module under test but never re-invokes
 * a mock factory.
 */
async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('./electron-mock');
}

async function getChildProcessMock() {
  const childProcess = await import('node:child_process');
  return childProcess as unknown as typeof import('./child-process-mock');
}

async function getLogMock() {
  const electronLog = await import('electron-log');
  return electronLog as unknown as typeof import('./electron-log-mock');
}

/** Let queued microtasks and one macrotask turn drain (crash handling is async). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for the `index`-th dev child to be spawned. `startServer` binds a free
 * port before forking, so the child does not exist synchronously.
 *
 * Polls on `setImmediate` rather than `vi.waitFor` so it keeps working in the
 * tests that fake `setTimeout` — real socket I/O still completes between
 * turns, which is what the free-port probe is waiting on.
 */
async function devChildAt(index: number): Promise<MockServerProcess> {
  const { forkedChildren } = await getChildProcessMock();
  return spawnedChildAt(forkedChildren, index, 'dev');
}

/** {@link devChildAt}'s packaged counterpart — the `utilityProcess.fork` path. */
async function utilityChildAt(index: number): Promise<MockServerProcess> {
  const { utilityProcessChildren } = await getElectronMock();
  return spawnedChildAt(utilityProcessChildren, index, 'utility process');
}

async function spawnedChildAt(
  children: MockServerProcess[],
  index: number,
  label: string
): Promise<MockServerProcess> {
  for (let turn = 0; turn < 1000 && !children[index]; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const child = children[index];
  if (!child) throw new Error(`${label} child #${index} was never spawned`);
  return child;
}

/** Drive `startServer` all the way to a ready server. */
async function startReadyServer(
  startServer: (accessor?: () => Electron.BrowserWindow | null) => Promise<number>,
  accessor?: () => Electron.BrowserWindow | null
): Promise<{ port: number; child: MockServerProcess }> {
  const started = startServer(accessor);
  const child = await devChildAt(0);
  child.emitReady();
  return { port: await started, child };
}

/**
 * Pretend this process is a packaged app. `app.isPackaged` alone is not
 * enough: the packaged spawn path also reads `process.resourcesPath`, which
 * only Electron defines.
 */
function stubPackagedPaths(): () => void {
  const original = (process as { resourcesPath?: string }).resourcesPath;
  Object.defineProperty(process, 'resourcesPath', {
    value: '/Applications/DorkOS.app/Contents/Resources',
    configurable: true,
  });
  return () => {
    Object.defineProperty(process, 'resourcesPath', { value: original, configurable: true });
  };
}

/** A dialog that never settles — for tests that only care that it was shown. */
function pendingDialog(): () => Promise<Electron.MessageBoxReturnValue> {
  return () => new Promise<Electron.MessageBoxReturnValue>(() => {});
}

/**
 * The supervisor installs a process-wide `unhandledRejection` logger, and
 * every test re-imports it through `vi.resetModules()`. Snapshot the listener
 * list so those copies never accumulate into a MaxListeners warning — and so a
 * listener a test registers itself is always removed.
 */
let originalRejectionListeners: Array<(...args: unknown[]) => void> = [];

beforeEach(async () => {
  vi.resetModules();
  originalRejectionListeners = process.listeners('unhandledRejection') as Array<
    (...args: unknown[]) => void
  >;
  (await getElectronMock()).resetElectronMock();
  (await getChildProcessMock()).resetChildProcessMock();
  (await getLogMock()).resetLogMock();
});

afterEach(() => {
  vi.useRealTimers();
  process.removeAllListeners('unhandledRejection');
  for (const listener of originalRejectionListeners) process.on('unhandledRejection', listener);
});

describe('startServer — the readiness handshake', () => {
  it('resolves with the port it handed the child and reports it from getServerPort()', async () => {
    const { startServer, getServerPort } = await import('../server-process');

    const { port, child } = await startReadyServer(startServer);

    expect(port).toBe(Number(child.env.DORKOS_PORT));
    expect(getServerPort()).toBe(port);
  });

  it('rejects when the child exits 0 before signalling ready (H5)', async () => {
    const { startServer, getServerPort } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    // A clean early exit used to clear the timeout without settling anything,
    // so `await startServer()` blocked forever inside app.on('ready') and the
    // app sat there with no window and no error.
    child.emitExit(0);

    await expect(started).rejects.toThrow(/exited/i);
    expect(getServerPort()).toBeNull();
  });

  it('rejects when the child exits non-zero before signalling ready', async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    child.emitExit(1);

    await expect(started).rejects.toThrow(/exited with code 1/i);
  });

  it('rejects and kills the child when it never signals ready', async () => {
    // Only setTimeout is faked: the free-port probe is real socket I/O, and
    // devChildAt polls on setImmediate to let it finish.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { startServer } = await import('../server-process');

    const started = startServer();
    const assertion = expect(started).rejects.toThrow(/did not start in time/i);
    const child = await devChildAt(0);
    await vi.advanceTimersByTimeAsync(SERVER_READY_PARENT_TIMEOUT_MS);
    await assertion;

    // A child left running would keep the port and the SQLite lock.
    expect(child.killed).toBe(true);
  });

  it('rejects with a clear message when the fork fails to spawn (M7)', async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    child.emitError(new Error('spawn tsx ENOENT'));

    await expect(started).rejects.toThrow(/ENOENT/);
  });

  it('rejects when the fork throws synchronously', async () => {
    const { failNextFork } = await getChildProcessMock();
    const { startServer, getServerPort } = await import('../server-process');

    failNextFork(new Error('spawn EACCES'));

    await expect(startServer()).rejects.toThrow(/EACCES/);
    expect(getServerPort()).toBeNull();
  });

  it('looks for the .cmd tsx shim on Windows and names it when missing (M7)', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const { startServer } = await import('../server-process');
      // Only the Windows branch can miss here: the extensionless Unix shim
      // exists in this repo, `tsx.cmd` does not.
      await expect(startServer()).rejects.toThrow(/tsx\.cmd/);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('settles the startup wait when a booting child exits during shutdown', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    const assertion = expect(started).rejects.toThrow(/before it was ready/i);

    // Cmd+Q while the server is still booting: app.on('ready') is still
    // awaiting startServer, and nothing else will ever settle it.
    const stopping = stopServer();
    child.emitExit(0);

    await stopping;
    await assertion;
  });

  it('settles the startup wait when a booting child never answers shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { startServer, stopServer } = await import('../server-process');

    const started = startServer();
    const assertion = expect(started).rejects.toThrow(/stopped before it finished starting/i);
    const child = await devChildAt(0);

    // This is the *guaranteed* shape of quit-during-boot, not an exotic one:
    // server-entry.ts only registers its shutdown listener after the health
    // poll succeeds, so a child that is still booting cannot answer. The
    // grace period runs out, the supervisor kills it, and its later exit is
    // ignored by the identity guard — so nothing but the kill path is left to
    // settle the startup wait.
    const stopping = stopServer();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    await stopping;
    await assertion;

    expect(child.killed).toBe(true);
  });

  it('ignores a late exit from a child it already gave up on', async () => {
    const { dialog } = await getElectronMock();
    dialog.showMessageBox = vi.fn(pendingDialog());
    const { startServer } = await import('../server-process');

    const failing = startServer();
    const abandoned = await devChildAt(0);
    abandoned.emitError(new Error('spawn tsx ENOENT'));
    await expect(failing).rejects.toThrow();
    expect(abandoned.killed).toBe(true);

    // Its exit lands after the supervisor moved on; it is not a crash.
    abandoned.emitExit(1);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('refuses to start a second server on top of a running one', async () => {
    const { startServer } = await import('../server-process');
    await startReadyServer(startServer);

    await expect(startServer()).rejects.toThrow(/second DorkOS server/);
  });
});

describe('the environment handed to the server child', () => {
  /**
   * A DORK_HOME the *test process* exports, so these assertions are about what
   * `buildServerEnv` contributes rather than about the developer's shell. The
   * child inherits `process.env` wholesale, so asserting "undefined" here
   * would go red for anyone who has DORK_HOME set.
   */
  const INHERITED_DORK_HOME = '/tmp/dor-533-inherited-dork-home';

  beforeEach(() => {
    vi.stubEnv('DORK_HOME', INHERITED_DORK_HOME);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('marks the server as desktop-managed so it refuses to restart itself', async () => {
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    expect(child.env.DORKOS_MANAGED_BY).toBe('desktop');
  });

  it('leaves DORK_HOME alone in dev, so the child picks its own dev data dir (M3)', async () => {
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    // Overriding DORK_HOME in dev pointed the dev build at the production
    // ~/.dork and applied unreleased migrations to it. Whatever the
    // environment already said is passed through untouched.
    expect(child.env.DORK_HOME).toBe(INHERITED_DORK_HOME);
    expect(child.env.NODE_ENV).toBe('development');
  });

  it('hands the dev child this process id to watch, and no pid when packaged', async () => {
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    // The child cannot derive this itself — tsx runs it as a grandchild, so
    // its own ppid is the tsx wrapper. See server-entry.ts's exitWhenOrphaned.
    expect(child.env.DORKOS_PARENT_PID).toBe(String(process.pid));
  });

  it('pins DORK_HOME to ~/.dork in a packaged build, spawned as a UtilityProcess', async () => {
    const restorePaths = stubPackagedPaths();
    try {
      const { app, utilityProcess } = await getElectronMock();
      app.isPackaged = true;
      const { startServer } = await import('../server-process');

      const started = startServer();
      const child = await utilityChildAt(0);
      child.emitReady();
      await started;

      expect(utilityProcess.fork).toHaveBeenCalledTimes(1);
      expect(child.env.DORK_HOME).toBe(join(app.getPath('home'), '.dork'));
      expect(child.env.NODE_ENV).toBe('production');
      expect(child.env.DORKOS_MANAGED_BY).toBe('desktop');
      // Electron tears a UtilityProcess down with the app; no watchdog needed.
      expect(child.env.DORKOS_PARENT_PID).toBeUndefined();
    } finally {
      restorePaths();
    }
  });
});

describe('the crash monitor', () => {
  it('treats a clean exit after startup as a crash and stops reporting a port (C1)', async () => {
    const { dialog } = await getElectronMock();
    const { default: log } = await getLogMock();
    dialog.showMessageBox = vi.fn(pendingDialog());
    const { startServer, getServerPort } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    // POST /api/admin/restart and "Reset All Data" both exit 0. The old
    // monitor ignored that, leaving getServerPort() handing out a dead port.
    child.emitExit(0);

    expect(log.error).toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(getServerPort()).toBeNull();
  });

  it('treats death by signal (exit code null) as a crash (C1)', async () => {
    const { dialog } = await getElectronMock();
    dialog.showMessageBox = vi.fn(pendingDialog());
    const { startServer, getServerPort } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    child.emitExit(null);

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(getServerPort()).toBeNull();
  });

  it('logs and surfaces the crash even when no window is focused (H2)', async () => {
    const { BrowserWindow, dialog } = await getElectronMock();
    const { default: log } = await getLogMock();
    // The app is in the background — the single most likely real crash.
    BrowserWindow.getFocusedWindow = vi.fn(() => null);
    dialog.showMessageBox = vi.fn(pendingDialog());
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    child.emitExit(1);

    expect(log.error).toHaveBeenCalled();
    // Nothing to anchor to, so the dialog is shown unanchored rather than
    // skipped: one argument, the options.
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dialog.showMessageBox).mock.calls[0]).toHaveLength(1);
  });

  it('anchors the dialog to the tracked main window, not the focused one (H2)', async () => {
    const { BrowserWindow, dialog } = await getElectronMock();
    const tracked = new BrowserWindow({ width: 1200, height: 800 });
    const somethingElse = new BrowserWindow({ width: 400, height: 300 });
    BrowserWindow.getFocusedWindow = vi.fn(() => somethingElse);
    dialog.showMessageBox = vi.fn(pendingDialog());
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(
      startServer,
      () => tracked as unknown as Electron.BrowserWindow
    );
    child.emitExit(1);

    expect(vi.mocked(dialog.showMessageBox).mock.calls[0][0]).toBe(tracked);
  });

  it('restarts on request, reloads the window, and never reports a stale port', async () => {
    const { BrowserWindow, dialog } = await getElectronMock();
    const tracked = new BrowserWindow({ width: 1200, height: 800 });
    dialog.showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
    const { startServer, getServerPort } = await import('../server-process');

    const { port, child } = await startReadyServer(
      startServer,
      () => tracked as unknown as Electron.BrowserWindow
    );
    child.emitExit(1);

    const replacement = await devChildAt(1);
    replacement.emitReady();
    await flush();

    const newPort = Number(replacement.env.DORKOS_PORT);
    expect(newPort).not.toBe(port);
    expect(getServerPort()).toBe(newPort);
    // Dev renderer comes from electron-vite, so it only needs a reload to
    // re-read the port over IPC.
    expect(tracked.reload).toHaveBeenCalledTimes(1);
  });

  it('moves a packaged window to the restarted server’s origin', async () => {
    const restorePaths = stubPackagedPaths();
    try {
      const { app, BrowserWindow, dialog } = await getElectronMock();
      app.isPackaged = true;
      const tracked = new BrowserWindow({ width: 1200, height: 800 });
      dialog.showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
      const { startServer, getServerPort } = await import('../server-process');

      const started = startServer(() => tracked as unknown as Electron.BrowserWindow);
      const child = await utilityChildAt(0);
      child.emitReady();
      await started;

      child.emitExit(1);
      const replacement = await utilityChildAt(1);
      replacement.emitReady();
      await flush();

      // A packaged renderer is served *by* the server, so it has to move to
      // the new origin — the port changed, and a stale one strands it.
      const newPort = Number(replacement.env.DORKOS_PORT);
      expect(getServerPort()).toBe(newPort);
      expect(tracked.loadURL).toHaveBeenCalledWith(`http://localhost:${newPort}`);
      expect(tracked.reload).not.toHaveBeenCalled();
    } finally {
      restorePaths();
    }
  });

  it('catches a restart that fails: logs it, tells the user, and quits (H1)', async () => {
    const { app, dialog } = await getElectronMock();
    const { default: log } = await getLogMock();
    const { failNextFork } = await getChildProcessMock();
    dialog.showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    const rejections: unknown[] = [];
    const captureRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', captureRejection);

    failNextFork(new Error('spawn EACCES'));
    child.emitExit(1);
    await flush();

    expect(log.error).toHaveBeenCalled();
    expect(dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // The old `.then()` had no `.catch`, so this became an unhandled rejection
    // with no dialog and no log.
    expect(rejections).toEqual([]);
  });

  it('quits when the user declines the restart', async () => {
    const { app, dialog } = await getElectronMock();
    dialog.showMessageBox = vi.fn(async () => ({ response: 1, checkboxChecked: false }));
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    child.emitExit(1);
    await flush();

    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the exit was the one stopServer asked for', async () => {
    const { dialog } = await getElectronMock();
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    const stopping = stopServer();
    child.emitExit(0);
    await stopping;
    await flush();

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});

describe('stopServer', () => {
  it('returns promptly when the child has already exited (M1)', async () => {
    const { dialog } = await getElectronMock();
    dialog.showMessageBox = vi.fn(pendingDialog());
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    child.emitExit(1);

    // Cmd+Q used to hang for the full grace period here, waiting on an `exit`
    // event from a process that had already exited.
    vi.useFakeTimers();
    await stopServer();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.killed).toBe(false);
  });

  it('is safe to call twice', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    const stopping = stopServer();
    child.emitExit(0);
    await stopping;

    await expect(stopServer()).resolves.toBeUndefined();
    expect(child.sent).toEqual([{ type: 'shutdown' }]);
  });

  it('resolves without a server ever having been started', async () => {
    const { stopServer } = await import('../server-process');

    await expect(stopServer()).resolves.toBeUndefined();
  });

  it('kills the child instead of throwing when the shutdown message cannot be sent (M1)', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    // A dead ChildProcess emits an `error` event from send(), which throws
    // when nothing is listening.
    child.sendError = new Error('channel closed');

    const stopping = stopServer();
    child.emitExit(0);
    await expect(stopping).resolves.toBeUndefined();
    expect(child.killed).toBe(true);
  });

  it('kills a child that ignores the shutdown message, then resolves', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    vi.useFakeTimers();
    const stopping = stopServer();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    await expect(stopping).resolves.toBeUndefined();

    expect(child.sent).toEqual([{ type: 'shutdown' }]);
    expect(child.killed).toBe(true);
  });
});

describe('the main process safety net', () => {
  it('logs an unhandled rejection instead of letting it vanish (H1)', async () => {
    const { default: log } = await getLogMock();
    const before = process.listenerCount('unhandledRejection');
    const { startServer } = await import('../server-process');

    await startReadyServer(startServer);

    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    const listener = process.listeners('unhandledRejection').at(-1) as (
      reason: unknown,
      promise: Promise<unknown>
    ) => void;
    listener(new Error('nothing awaited me'), Promise.resolve());

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Unhandled'), expect.any(Error));
  });
});
