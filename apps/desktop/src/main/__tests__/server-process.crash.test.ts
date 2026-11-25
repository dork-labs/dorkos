import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  devChildAt,
  flush,
  forkCount,
  getChildProcessMock,
  getElectronMock,
  getLogMock,
  startReadyServer,
  stubPackagedPaths,
  until,
  useServerProcessHarness,
  utilityChildAt,
} from './server-process.fixtures';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

useServerProcessHarness();

describe('the crash monitor', () => {
  /** Restart with millisecond waits, so every try runs without real seconds passing. */
  async function fastRestarts(): Promise<void> {
    const { setRestartTimingForTests } = await import('../server-crash-recovery');
    setRestartTimingForTests({ firstDelayMs: 1, maxDelayMs: 2, noticeDelayMs: 0 });
  }

  /** Every `server:restarting` value sent to `win` so far. */
  function restartingSignals(win: { webContents: { send: { mock: { calls: unknown[][] } } } }) {
    return win.webContents.send.mock.calls
      .filter(([channel]) => channel === 'server:restarting')
      .map(([, value]) => value);
  }

  beforeEach(fastRestarts);

  it('treats a clean exit after startup as a crash and restarts on its own (C1)', async () => {
    const { dialog } = await getElectronMock();
    const { default: log } = await getLogMock();
    const { startServer, getServerPort } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    // POST /api/admin/restart and "Reset All Data" both exit 0. The old
    // monitor ignored that, leaving getServerPort() handing out a dead port.
    child.emitExit(0);

    expect(log.error).toHaveBeenCalled();
    expect(getServerPort()).toBeNull();
    const replacement = await devChildAt(1);
    replacement.emitReady();
    await until('the replacement to serve', () => getServerPort() !== null);
    // Nobody is asked first (DOR-3229).
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('restarts onto the same address, reloads the window, and reports the live port', async () => {
    const { BrowserWindow } = await getElectronMock();
    const tracked = new BrowserWindow({ width: 1200, height: 800 });
    const { startServer, getServerPort } = await import('../server-process');

    const { port, child } = await startReadyServer(startServer);
    child.emitExit(1);

    const replacement = await devChildAt(1);
    replacement.emitReady();
    await until('the window to be reloaded', () => tracked.reload.mock.calls.length > 0);

    const newPort = Number(replacement.env.DORKOS_PORT);
    // The dead server let its port go, so the replacement asks for the same
    // one and gets it. A bookmark, an MCP client config, and a `dorkos://`
    // link all survive a crash because of this.
    expect(newPort).toBe(port);
    expect(getServerPort()).toBe(newPort);
    // Dev renderer comes from electron-vite, so it only needs a reload to
    // re-read the port over IPC.
    expect(tracked.reload).toHaveBeenCalledTimes(1);
    // The restarting bar is on while it restarts, and off once it is back.
    expect(restartingSignals(tracked).at(-1)).toBe(false);
  });

  it('moves a packaged window to the restarted server’s origin', async () => {
    const restorePaths = stubPackagedPaths();
    try {
      const { app, BrowserWindow } = await getElectronMock();
      app.isPackaged = true;
      const tracked = new BrowserWindow({ width: 1200, height: 800 });
      const { startServer, getServerPort } = await import('../server-process');

      const started = startServer();
      const child = await utilityChildAt(0);
      child.emitReady();
      await started;

      child.emitExit(1);
      const replacement = await utilityChildAt(1);
      replacement.emitReady();
      await until('the window to move', () => tracked.loadURL.mock.calls.length > 0);

      // A packaged renderer is served *by* the server, so it has to be sent
      // back to the origin — its connection died with the old process.
      const newPort = Number(replacement.env.DORKOS_PORT);
      expect(getServerPort()).toBe(newPort);
      expect(tracked.loadURL).toHaveBeenCalledWith(`http://localhost:${newPort}`);
      expect(tracked.reload).not.toHaveBeenCalled();
    } finally {
      restorePaths();
    }
  });

  it('logs a restart that fails with its real error, and tries again (H1)', async () => {
    const { default: log } = await getLogMock();
    const { failNextFork } = await getChildProcessMock();
    const { startServer, getServerPort } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    const rejections: unknown[] = [];
    const captureRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', captureRejection);

    failNextFork(new Error('spawn EACCES'));
    child.emitExit(1);
    // The first try fails to spawn; the second spawns the replacement.
    const replacement = await devChildAt(1);
    replacement.emitReady();
    await until('the replacement to serve', () => getServerPort() !== null);

    const logged = vi.mocked(log.error).mock.calls.map((call) => call.map(String).join(' '));
    expect(
      logged.some((line) => line.includes('Restart 1 of 4 failed') && line.includes('spawn EACCES'))
    ).toBe(true);
    expect(rejections).toEqual([]);
  });

  it('stops after its tries with the "DorkOS stopped" page, and notifies once', async () => {
    const { BrowserWindow, Notification } = await getElectronMock();
    const { default: log } = await getLogMock();
    const { failEveryFork } = await getChildProcessMock();
    const tracked = new BrowserWindow({ width: 1200, height: 800 });
    // The app is in the background — the likeliest moment for a crash.
    BrowserWindow.getFocusedWindow = vi.fn(() => null);
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    // A failure no retry can get past — the shape of a `dorkos` CLI server
    // already holding the data directory.
    failEveryFork(new Error('Another DorkOS server is already using ~/.dork (pid 8123)'));
    child.emitExit(1);

    await until('the stopped page', () => tracked.loadFile.mock.calls.length > 0);

    const [file, options] = tracked.loadFile.mock.calls[0] as unknown as [
      string,
      { query: { tries: string } },
    ];
    expect(file).toMatch(/server-stopped\.html$/);
    // The real count from the cap, never a hard-coded one.
    expect(options.query.tries).toBe('4');
    // Each try's own words are in the log.
    const logged = vi.mocked(log.error).mock.calls.map((call) => call.map(String).join(' '));
    expect(logged.filter((line) => line.includes('already using ~/.dork'))).toHaveLength(4);
    // One notification, because no DorkOS window was in front.
    expect(Notification.instances).toHaveLength(1);
    expect(Notification.instances[0]?.options).toMatchObject({
      title: 'DorkOS stopped',
      body: 'Click to restart',
    });
    expect(restartingSignals(tracked).at(-1)).toBe(false);
  });

  it('caps a server that keeps booting and dying, not just one that fails to spawn', async () => {
    const { BrowserWindow } = await getElectronMock();
    const tracked = new BrowserWindow({ width: 1200, height: 800 });
    const { startServer, getServerPort } = await import('../server-process');

    let { child } = await startReadyServer(startServer);

    // Every restart *succeeds* and then dies seconds later. Counting only
    // failed spawns never caps this, so it would loop forever.
    for (let cycle = 0; cycle < 8; cycle++) {
      child.emitExit(1);
      await until(
        `the shell to answer crash #${cycle + 1}`,
        () => forkCount() > cycle + 1 || tracked.loadFile.mock.calls.length > 0
      );
      if (tracked.loadFile.mock.calls.length > 0) break;
      child = await devChildAt(cycle + 1);
      child.emitReady();
      await until(`restart #${cycle + 1} to be serving`, () => getServerPort() !== null);
    }

    await until('the app to give up', () => tracked.loadFile.mock.calls.length > 0);
    // Four restarts and no more.
    expect(forkCount()).toBe(5);
  });

  it('stays quiet when the exit was the one stopServer asked for', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    const stopping = stopServer();
    child.emitExit(0);
    await stopping;
    await flush();
    await flush();

    expect(forkCount()).toBe(1);
  });
});
