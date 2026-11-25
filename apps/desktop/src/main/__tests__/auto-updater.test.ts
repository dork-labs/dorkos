import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UpdateDownloadedEvent } from 'electron-updater';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-updater', () => import('./electron-updater-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));
// The restart path stops the server itself now (DOR-1455): it has to be down
// before the installer's quit begins, and *when* it goes down is the ordering
// these tests pin.
vi.mock('../server-process', () => ({
  startServer: vi.fn(async () => 4242),
  stopServer: vi.fn(async () => undefined),
  getServerPort: vi.fn(() => 4242),
}));
// Launch-time purging drives the real filesystem; its own suite covers what it
// deletes. Here it only has to be *called*, and only when packaged.
vi.mock('../updater/cache', () => ({ purgeStaleStagedUpdates: vi.fn(() => []) }));
import { getAutoUpdaterMock, getElectronMock, getUpdaterLog } from './auto-updater.fixtures';

/** The mocked server supervisor, whose `stopServer` the restart path calls directly. */
async function getServerProcessMock() {
  return import('../server-process');
}

/** Mirrors `STALLED_RESTART_TIMEOUT_MS` in `auto-updater.ts`. */
const STALLED_RESTART_TIMEOUT_MS = 15_000;

describe('restarting to install an update (DOR-538)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Two tests below jump the clock with `vi.setSystemTime`, which *freezes*
    // `Date.now()` rather than offsetting it. Left unrestored it leaks to every
    // later test in this file: nothing here reads the clock for an assertion
    // today, so it would sit latent until someone adds a test that needs wall
    // time to pass and silently sees zero elapsed.
    vi.useRealTimers();
  });

  /**
   * Wire the updater and the quit guard together the way `index.ts` does, with
   * `app.isPackaged` true — the restart path no-ops without it, which is why
   * nothing reached it before.
   */
  async function armUpdateRestart(activeAgents = 0) {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();
    const { stopServer } = await getServerProcessMock();
    vi.mocked(stopServer).mockClear();
    vi.mocked(stopServer).mockResolvedValue(undefined);

    const autoUpdaterModule = await import('../auto-updater');
    const quitGuard = await import('../quit-guard');
    quitGuard.resetQuitGuard();
    autoUpdaterModule.resetUpdateRestartState();
    // The guard's own shutdown, which an update restart must never reach: by
    // the time the installer quits, `stopServer` above has already run.
    const shutdown = vi.fn(() => Promise.resolve());
    quitGuard.armQuitGuard({
      countActiveAgents: () => activeAgents,
      getWindow: () => null,
      shutdown,
      consumeUpdateRestart: autoUpdaterModule.consumeUpdateRestart,
      recordUpdateInstallIntent: autoUpdaterModule.recordUpdateInstallIntent,
    });
    return { app, autoUpdater, autoUpdaterModule, quitGuard, shutdown, stopServer };
  }

  it('asks about mid-run agents BEFORE arming the installer, not after the windows are gone', async () => {
    const { dialog } = await getElectronMock();
    const { autoUpdater, autoUpdaterModule } = await armUpdateRestart(3);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));

    await autoUpdaterModule.restartToUpdate();

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [
      Electron.MessageBoxOptions,
    ];
    // A restart is not a quit. Telling someone who clicked "Restart to install"
    // to close the window instead is advice that does not install their update,
    // and on the native branch there is no window to close.
    expect(options).toMatchObject({
      title: 'Restart to Update?',
      message: '3 agents are still working or waiting on your answer. Restart anyway?',
      buttons: ['Keep Working', 'Restart Anyway'],
    });
    expect(options.detail).not.toContain('close the window');
    // "Keep Working" here costs nothing: the installer was never armed, and the
    // update still lands on the next ordinary quit.
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(autoUpdaterModule.isRestartingToUpdate()).toBe(false);
  });

  it('does not ask twice, and does not intercept the installer’s quit', async () => {
    const { app, dialog } = await getElectronMock();
    const { autoUpdaterModule, shutdown, stopServer } = await armUpdateRestart(2);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    await autoUpdaterModule.restartToUpdate();
    vi.mocked(dialog.showMessageBox).mockClear();

    // quitAndInstall()'s own app.quit(), arriving after the windows closed.
    const preventDefault = vi.fn();
    await app.emit('before-quit', { preventDefault });
    await new Promise((resolve) => setImmediate(resolve));

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    // The server went down before the installer was ever called, so the guard
    // has nothing left to do — and cancelling this quit to do it anyway is what
    // shipped ten days of updates that never installed.
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('stays armed while the restart is merely deferred, then completes it silently', async () => {
    // The likely macOS path, and the one a previous fix broke.
    // `MacUpdater.quitAndInstall()` quits only `if (this.squirrelDownloadedUpdate)`;
    // otherwise it registers a deferred `update-downloaded` listener and
    // returns with the app alive — the restart is still coming, just later. A
    // mock that simply returns is exactly that branch.
    const { app, dialog } = await getElectronMock();
    const { autoUpdater, autoUpdaterModule, shutdown, stopServer } = await armUpdateRestart(2);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));

    await autoUpdaterModule.restartToUpdate();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));

    // Deferred is not "did not take". Disarming here is what put the
    // background notice back in the middle of an update.
    expect(autoUpdaterModule.isRestartingToUpdate()).toBe(true);

    // Squirrel finishes seconds later: the windows close, then the quit comes.
    vi.mocked(dialog.showMessageBox).mockClear();
    const preventDefault = vi.fn();
    await app.emit('window-all-closed');
    await app.emit('before-quit', { preventDefault });
    await new Promise((resolve) => setImmediate(resolve));

    // One decision, one dialog — and it was asked before any of this. The
    // server went down with that decision, not with this quit.
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not silence a quit that is no longer the restart the person confirmed', async () => {
    const { app, dialog } = await getElectronMock();
    const { autoUpdaterModule } = await armUpdateRestart(2);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    await autoUpdaterModule.restartToUpdate();

    // The skip rides on "you authorised this moments ago", so that is what
    // expires. Ten minutes on, an unrelated Cmd+Q is not that restart.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));
    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [
      Electron.MessageBoxOptions,
    ];
    expect(options.message).toBe(
      '2 agents are still working or waiting on your answer. Quit anyway?'
    );
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('re-authorises from the native updater when a deferred restart finally quits', async () => {
    const { app, autoUpdater: nativeAutoUpdater, dialog } = await getElectronMock();
    const { autoUpdaterModule } = await armUpdateRestart(2);
    autoUpdaterModule.setupAutoUpdater(() => null);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    await autoUpdaterModule.restartToUpdate();

    // A restart slower than the grace window: without a refresh the quit it
    // finally produces would be asked about a second time.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    nativeAutoUpdater.emit('before-quit-for-update');

    vi.mocked(dialog.showMessageBox).mockClear();
    const preventDefault = vi.fn();
    await app.emit('before-quit', { preventDefault });
    await new Promise((resolve) => setImmediate(resolve));

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('routes the native "Restart Now" dialog through the same path', async () => {
    const { dialog } = await getElectronMock();
    const { autoUpdater, autoUpdaterModule } = await armUpdateRestart(1);
    autoUpdaterModule.setupAutoUpdater(() => null);
    // "Keep Working" on the agent question.
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));

    // No window, so update-downloaded shows the native dialog; response 0 there
    // is "Restart Now", which must reach the same confirmation.
    autoUpdater.emit('update-downloaded', { version: '2.0.0' } as UpdateDownloadedEvent);

    await vi.waitFor(() => {
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    });
    const [agentPrompt] = vi.mocked(dialog.showMessageBox).mock.calls[1] as [
      Electron.MessageBoxOptions,
    ];
    expect(agentPrompt.message).toBe(
      '1 agent is still working or waiting on your answer. Restart anyway?'
    );
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});

/**
 * The install path (spec `desktop-updater-overhaul` D6–D9, DOR-1455).
 *
 * The evidence these exist for: ten days of "Restart to install" that quit and
 * came back on the old version, while the passive install-on-quit path
 * eventually worked. The difference between the two is that ours cancelled the
 * quit Squirrel had started. So the order of operations IS the fix, and it is
 * what these pin.
 */
describe('handing the restart to the installer (DOR-1455)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * Boot the updater and the quit guard as `index.ts` does, with an update
   * staged and a window open.
   *
   * The window matters: with one present, `update-downloaded` suppresses the
   * native "Update Ready" dialog and leaves the in-app card to offer the
   * restart — which is the path these cases drive. Without it, staging an
   * update would itself pop a modal whose default answer starts a second,
   * unasked-for restart.
   */
  async function bootWithStagedUpdate(activeAgents = 0, staged = '0.64.0') {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    app.getVersion = vi.fn(() => '0.63.0');
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();
    const { stopServer } = await getServerProcessMock();
    vi.mocked(stopServer).mockClear();
    vi.mocked(stopServer).mockResolvedValue(undefined);

    const log = await getUpdaterLog();
    const intent = await import('../updater-intent');
    const autoUpdaterModule = await import('../auto-updater');
    const quitGuard = await import('../quit-guard');
    quitGuard.resetQuitGuard();
    autoUpdaterModule.resetUpdateRestartState();
    const shutdown = vi.fn(() => Promise.resolve());
    quitGuard.armQuitGuard({
      countActiveAgents: () => activeAgents,
      getWindow: () => null,
      shutdown,
      consumeUpdateRestart: autoUpdaterModule.consumeUpdateRestart,
      recordUpdateInstallIntent: autoUpdaterModule.recordUpdateInstallIntent,
    });
    const win = new BrowserWindow({ width: 1200, height: 800 });
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    autoUpdater.emit('update-downloaded', { version: staged } as UpdateDownloadedEvent);
    return { app, autoUpdater, autoUpdaterModule, intent, log, shutdown, stopServer, win };
  }

  it('asks, records, stops the server, arms, and only then calls quitAndInstall', async () => {
    const { dialog } = await getElectronMock();
    const { autoUpdater, autoUpdaterModule, intent, stopServer } = await bootWithStagedUpdate(2);

    const order: string[] = [];
    dialog.showMessageBox = vi.fn(() => {
      order.push('confirm');
      return Promise.resolve({ response: 1, checkboxChecked: false });
    });
    // Observations are recorded and asserted after the run, never inside these
    // callbacks: `stopServer` is awaited inside a try/catch that would swallow
    // a thrown expectation and leave the test green.
    const seen: Record<string, unknown> = {};
    vi.mocked(stopServer).mockImplementation(async () => {
      order.push('stopServer');
      seen.intentAtStop = intent.readUpdateIntent();
      seen.armedAtStop = autoUpdaterModule.isRestartingToUpdate();
    });
    vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
      order.push('quitAndInstall');
      seen.armedAtInstall = autoUpdaterModule.isRestartingToUpdate();
    });

    await autoUpdaterModule.restartToUpdate();

    expect(order).toEqual(['confirm', 'stopServer', 'quitAndInstall']);
    // Written before the shutdown: a server that hangs on the way down must not
    // cost us the record of what this restart was about to install.
    expect(seen.intentAtStop).toMatchObject({ offeredVersion: '0.64.0', attempts: 1 });
    // Armed after it: the token tells the quit guard to stand aside, and it must
    // not be standing while the server is still on its way down.
    expect(seen.armedAtStop).toBe(false);
    expect(seen.armedAtInstall).toBe(true);
  });

  it('never calls the installer when the person keeps their agents working', async () => {
    const { dialog } = await getElectronMock();
    const { autoUpdater, autoUpdaterModule, stopServer } = await bootWithStagedUpdate(2);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));

    await autoUpdaterModule.restartToUpdate();

    // Nothing happened at all: the server is up, nothing is armed, and the
    // update still lands on the next ordinary quit.
    expect(stopServer).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(autoUpdaterModule.isRestartingToUpdate()).toBe(false);
  });

  it('restarts anyway when the server refuses to stop', async () => {
    const { autoUpdater, autoUpdaterModule, log, stopServer } = await bootWithStagedUpdate();
    vi.mocked(stopServer).mockRejectedValue(new Error('the server hung'));

    await autoUpdaterModule.restartToUpdate();

    // A server that will not go down must not trap someone in an app they asked
    // to restart; the quit takes the child with it either way.
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalled();
  });

  /**
   * The branch that issues nothing at all.
   *
   * `MacUpdater.quitAndInstall()` quits only `if (this.squirrelDownloadedUpdate)`;
   * otherwise it registers a deferred listener and returns — and with
   * `autoInstallOnAppQuit` true it does not even ask Squirrel to check. If
   * Squirrel then fails the way it silently does (electron/electron#8912),
   * nothing further arrives at all. The old code survived that by doing nothing;
   * this one has already stopped the server, so surviving it takes work.
   */
  it('comes back to life when the installer errors after taking the app’s server', async () => {
    const { autoUpdater, autoUpdaterModule, win } = await bootWithStagedUpdate();
    const { startServer } = await getServerProcessMock();
    vi.mocked(startServer).mockClear();
    vi.mocked(startServer).mockResolvedValue(4242);

    await autoUpdaterModule.restartToUpdate();
    // quitAndInstall() returned without quitting: the deferred branch.
    expect(autoUpdaterModule.isRestartingToUpdate()).toBe(true);

    autoUpdater.emit('error', new Error('Could not get code signature for running application'));

    await vi.waitFor(() => {
      expect(startServer).toHaveBeenCalledTimes(1);
    });
    // And the window is put back in front of it, wherever it came up.
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:4242');
    expect(autoUpdaterModule.getLastUpdateStatus()).toMatchObject({
      state: 'install-failed',
      version: '0.64.0',
    });
  });

  it('comes back to life when the installer says nothing at all', async () => {
    // No quit, no error, no event of any kind — the reported condition. Only a
    // deadline can tell this apart from a restart still in progress.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { autoUpdaterModule, win } = await bootWithStagedUpdate();
      const { startServer } = await getServerProcessMock();
      vi.mocked(startServer).mockClear();
      vi.mocked(startServer).mockResolvedValue(4242);

      await autoUpdaterModule.restartToUpdate();
      expect(startServer).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(STALLED_RESTART_TIMEOUT_MS);

      expect(startServer).toHaveBeenCalledTimes(1);
      expect(win.loadURL).toHaveBeenCalledWith('http://localhost:4242');
      expect(autoUpdaterModule.getLastUpdateStatus()).toMatchObject({
        state: 'install-failed',
        version: '0.64.0',
      });
      // The card must not still be offering the restart that just failed.
      expect(autoUpdaterModule.isRestartingToUpdate()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restart the server for a restart that was never armed', async () => {
    // The watchdog belongs to a handoff. A declined restart armed nothing, and
    // must not have a timer restarting a server that never stopped.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { dialog } = await getElectronMock();
      const { autoUpdaterModule } = await bootWithStagedUpdate(2);
      const { startServer } = await getServerProcessMock();
      vi.mocked(startServer).mockClear();
      dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));

      await autoUpdaterModule.restartToUpdate();
      await vi.advanceTimersByTimeAsync(STALLED_RESTART_TIMEOUT_MS * 2);

      expect(startServer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts one restart as ONE attempt, though it passes both recording paths', async () => {
    // The restart records, then `quitAndInstall()`'s own `app.quit()` reaches
    // the quit sequence, which asks again. Two writes would send the card to
    // "Download fresh copy" after a single ordinary failure.
    const { app, autoUpdaterModule, intent } = await bootWithStagedUpdate();

    await autoUpdaterModule.restartToUpdate();
    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(intent.readUpdateIntent()?.attempts).toBe(1);
  });

  it('counts the quit after a failed restart as the next attempt, and the error as none', async () => {
    // The macOS shape: quitAndInstall deferred, then Squirrel refused, and the
    // app is still up. The staged copy is untouched on disk, so
    // `autoInstallOnAppQuit` really will hand it over again on the next quit —
    // that quit is a further attempt and is counted. The error itself is not:
    // nothing was handed to anyone by an event.
    const { app, autoUpdater, autoUpdaterModule, intent } = await bootWithStagedUpdate();

    await autoUpdaterModule.restartToUpdate();
    expect(intent.readUpdateIntent()?.attempts).toBe(1);

    autoUpdater.emit('error', new Error('Could not get code signature'));
    // The restart took the server down; recovery brings it back and says what
    // actually happened, which the card turns into the remedy that works.
    await vi.waitFor(() => {
      expect(autoUpdaterModule.getLastUpdateStatus()).toMatchObject({ state: 'install-failed' });
    });
    expect(intent.readUpdateIntent()?.attempts).toBe(1);

    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(intent.readUpdateIntent()?.attempts).toBe(2);
  });

  it('clears a stale staged update at launch, before the first check', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();
    const { purgeStaleStagedUpdates } = await import('../updater/cache');
    vi.mocked(purgeStaleStagedUpdates).mockClear();
    const order: string[] = [];
    vi.mocked(purgeStaleStagedUpdates).mockImplementation(() => {
      order.push('purge');
      return [];
    });
    vi.mocked(autoUpdater.checkForUpdatesAndNotify).mockImplementation(async () => {
      order.push('check');
      return null;
    });

    const { setupAutoUpdater } = await import('../auto-updater');
    setupAutoUpdater(() => null);

    // Purging after the check would delete what the check had just staged.
    expect(order).toEqual(['purge', 'check']);
  });

  it('touches nothing on disk in an unpackaged build', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = false;
    const { resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();
    const { purgeStaleStagedUpdates } = await import('../updater/cache');
    vi.mocked(purgeStaleStagedUpdates).mockClear();

    const { setupAutoUpdater } = await import('../auto-updater');
    setupAutoUpdater(() => null);

    expect(purgeStaleStagedUpdates).not.toHaveBeenCalled();
  });
});
