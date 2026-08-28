import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-updater', () => import('./electron-updater-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

/**
 * `vi.mock(..., factory)` memoizes its result for the whole test file, so
 * mock state is fetched through the real specifier (matching the pattern in
 * `index.test.ts`) rather than importing the mock modules directly.
 */
async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('./electron-mock');
}

async function getAutoUpdaterMock() {
  const electronUpdater = await import('electron-updater');
  return electronUpdater as unknown as typeof import('./electron-updater-mock');
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

describe('setupAutoUpdater / checkForUpdatesInteractive (C1/C2)', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    setIntervalSpy = vi.spyOn(global, 'setInterval');
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it('no-ops entirely when !app.isPackaged: no autoUpdater calls, no interval', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = false;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater, checkForUpdatesInteractive } = await import('../auto-updater');

    setupAutoUpdater(() => null);
    expect(autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    checkForUpdatesInteractive();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('registers a 4h background interval and unrefs it when packaged', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const unref = vi.fn();
    setIntervalSpy.mockReturnValue({ unref } as unknown as NodeJS.Timeout);

    const { setupAutoUpdater } = await import('../auto-updater');
    setupAutoUpdater(() => null);

    expect(autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), FOUR_HOURS_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('interactive check: update-not-available shows "up to date" dialog', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater, checkForUpdatesInteractive } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();

    checkForUpdatesInteractive();
    autoUpdater.emit('update-not-available', { version: '1.0.0' } as UpdateInfo);

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ message: "You're up to date" })
    );
  });

  it('background check: update-not-available shows no dialog', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();

    // Not preceded by checkForUpdatesInteractive() — this is the launch/interval path.
    autoUpdater.emit('update-not-available', { version: '1.0.0' } as UpdateInfo);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('update-downloaded with a window present: suppresses the native dialog and pushes downloaded status to the renderer', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();

    autoUpdater.emit('update-downloaded', { version: '2.0.0' } as UpdateDownloadedEvent);

    // The in-app card owns the restart affordance when a window exists.
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('update:status', {
      state: 'downloaded',
      version: '2.0.0',
    });
  });

  it('update-downloaded with no window: shows the native dialog; Restart Now (response 0) calls quitAndInstall', async () => {
    const { app, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater } = await import('../auto-updater');
    setupAutoUpdater(() => null);

    autoUpdater.emit('update-downloaded', { version: '2.0.0' } as UpdateDownloadedEvent);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ['Restart Now', 'Later'] })
    );

    await vi.waitFor(() => {
      expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  it('update-downloaded with no window: Later (response 1) does not call quitAndInstall', async () => {
    const { app, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater } = await import('../auto-updater');
    setupAutoUpdater(() => null);

    autoUpdater.emit('update-downloaded', { version: '2.0.0' } as UpdateDownloadedEvent);

    await vi.waitFor(() => {
      expect(dialog.showMessageBox).toHaveBeenCalled();
    });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('pushes lifecycle statuses to the renderer (checking / available / not-available / downloading / error)', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(win.webContents.send).mockClear();

    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-available', { version: '2.0.0' } as UpdateInfo);
    autoUpdater.emit('download-progress', { percent: 42 } as ProgressInfo);
    autoUpdater.emit('update-not-available', { version: '1.0.0' } as UpdateInfo);
    autoUpdater.emit('error', new Error('boom'));

    const send = vi.mocked(win.webContents.send);
    expect(send).toHaveBeenCalledWith('update:status', { state: 'checking' });
    expect(send).toHaveBeenCalledWith('update:status', { state: 'available', version: '2.0.0' });
    expect(send).toHaveBeenCalledWith('update:status', { state: 'downloading', percent: 42 });
    expect(send).toHaveBeenCalledWith('update:status', { state: 'not-available' });
    expect(send).toHaveBeenCalledWith('update:status', { state: 'error', message: 'boom' });
  });

  it('latches downloading/downloaded for replay; transient statuses do not clobber a stored downloaded', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater, getLastUpdateStatus } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    expect(getLastUpdateStatus()).toBeNull();

    autoUpdater.emit('download-progress', { percent: 30 } as ProgressInfo);
    expect(getLastUpdateStatus()).toEqual({ state: 'downloading', percent: 30 });

    autoUpdater.emit('update-downloaded', { version: '2.0.0' } as UpdateDownloadedEvent);
    expect(getLastUpdateStatus()).toEqual({ state: 'downloaded', version: '2.0.0' });

    // A background re-check (checking → not-available) must not erase the
    // stored downloaded update.
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-not-available', { version: '1.0.0' } as UpdateInfo);
    expect(getLastUpdateStatus()).toEqual({ state: 'downloaded', version: '2.0.0' });
  });

  it('restartToUpdate calls quitAndInstall when packaged, and no-ops otherwise', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { restartToUpdate } = await import('../auto-updater');

    app.isPackaged = false;
    await restartToUpdate();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    // With no quit guard armed there is nothing to ask about, so this goes
    // straight through — the agent question is exercised in the DOR-538 suite.
    app.isPackaged = true;
    await restartToUpdate();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('interactive error shows an error dialog', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater, checkForUpdatesInteractive } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();

    checkForUpdatesInteractive();
    autoUpdater.emit('error', new Error('network down'));

    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ type: 'error' })
    );
  });

  it('background error only logs, no dialog', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();

    autoUpdater.emit('error', new Error('network down'));

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('interactive check: a not-yet-ready release (metadata 404) shows a calm notice, not an error', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater, checkForUpdatesInteractive } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();
    vi.mocked(win.webContents.send).mockClear();

    checkForUpdatesInteractive();
    // The exact shape electron-updater's GitHub provider throws while the newest
    // release exists but its installer/metadata has not been attached yet.
    autoUpdater.emit(
      'error',
      new Error(
        'Cannot find latest-mac.yml in the latest release artifacts ' +
          '(https://github.com/dork-labs/dorkos/releases/download/v0.48.0/latest-mac.yml): HttpError: 404'
      )
    );

    // Calm info notice, never a scary "Update Check Failed" error dialog.
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ type: 'info', title: 'Update Not Ready Yet' })
    );
    // The renderer card sees "not-available", never an error state.
    expect(win.webContents.send).toHaveBeenCalledWith('update:status', { state: 'not-available' });
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'error' })
    );
  });

  it('background check: a not-yet-ready release (metadata 404) is silent and never an error status', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();
    vi.mocked(win.webContents.send).mockClear();

    autoUpdater.emit(
      'error',
      new Error('Cannot find latest.yml in the latest release artifacts: HttpError: 404')
    );

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('update:status', { state: 'not-available' });
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'error' })
    );
  });

  it('interactive check: an error event followed by a promise rejection surfaces only one dialog', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();
    // Mirror electron-updater's real behavior: it BOTH emits `error` and rejects
    // the returned promise. The `error` handler runs first and clears the flag,
    // so the catch must not fire a second dialog.
    autoUpdater.checkForUpdates = vi.fn(() => {
      autoUpdater.emit('error', new Error('network down'));
      return Promise.reject(new Error('network down'));
    });

    const { setupAutoUpdater, checkForUpdatesInteractive } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();

    checkForUpdatesInteractive();

    await vi.waitFor(() => {
      expect(dialog.showMessageBox).toHaveBeenCalled();
    });
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('interactive check: checkForUpdates() rejecting with a not-ready release (error code, no event) shows the calm notice', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();
    // Rejection with NO matching `error` event — the only path that reaches the
    // catch's not-ready branch. Detected via electron-updater's stable error
    // code, not the message text.
    const notReady = Object.assign(new Error('opaque provider failure'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    autoUpdater.checkForUpdates = vi.fn(() => Promise.reject(notReady));

    const { setupAutoUpdater, checkForUpdatesInteractive } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();
    vi.mocked(win.webContents.send).mockClear();

    checkForUpdatesInteractive();

    await vi.waitFor(() => {
      expect(dialog.showMessageBox).toHaveBeenCalledWith(
        win,
        expect.objectContaining({ type: 'info', title: 'Update Not Ready Yet' })
      );
    });
    // The card resolves off `checking` even though no `error` event fired.
    expect(win.webContents.send).toHaveBeenCalledWith('update:status', { state: 'not-available' });
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ state: 'error' })
    );
  });

  it('interactive check: checkForUpdates() rejecting shows an error dialog and clears the interactive flag', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();
    autoUpdater.checkForUpdates = vi.fn(() => Promise.reject(new Error('offline')));

    const { setupAutoUpdater, checkForUpdatesInteractive } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();

    checkForUpdatesInteractive();

    await vi.waitFor(() => {
      expect(dialog.showMessageBox).toHaveBeenCalledWith(
        win,
        expect.objectContaining({ type: 'error', detail: 'offline' })
      );
    });

    // The catch handler clears `checkingInteractively` before returning, so a
    // later background event must not dialog.
    vi.mocked(dialog.showMessageBox).mockClear();
    autoUpdater.emit('update-not-available', { version: '1.0.0' } as UpdateInfo);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('falls back to the options-only showMessageBox overload when no main window is tracked', async () => {
    const { app, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater, checkForUpdatesInteractive } = await import('../auto-updater');
    setupAutoUpdater(() => null);
    vi.mocked(dialog.showMessageBox).mockClear();

    checkForUpdatesInteractive();
    autoUpdater.emit('update-not-available', { version: '1.0.0' } as UpdateInfo);

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "You're up to date" })
    );
    // Single-argument overload: no window as the first argument.
    expect(vi.mocked(dialog.showMessageBox).mock.calls[0]).toHaveLength(1);
  });
});

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
    return { app, autoUpdater, autoUpdaterModule, quitGuard, shutdown };
  }

  it('arms the installer and flags the restart, so window-all-closed can stay quiet', async () => {
    const { autoUpdater, autoUpdaterModule } = await armUpdateRestart();

    await autoUpdaterModule.restartToUpdate();

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    // quitAndInstall() closes every window BEFORE calling app.quit(), so this
    // has to be true by the time `window-all-closed` fires. `isQuitting()` is
    // still false there — `before-quit` has not happened yet.
    expect(autoUpdaterModule.isRestartingToUpdate()).toBe(true);
  });

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

  it('restarts once confirmed', async () => {
    const { dialog } = await getElectronMock();
    const { autoUpdater, autoUpdaterModule } = await armUpdateRestart(2);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));

    await autoUpdaterModule.restartToUpdate();

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdaterModule.isRestartingToUpdate()).toBe(true);
  });

  it('does not ask twice: the quit that follows skips the confirmation', async () => {
    const { app, dialog } = await getElectronMock();
    const { autoUpdaterModule, shutdown } = await armUpdateRestart(2);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    await autoUpdaterModule.restartToUpdate();
    vi.mocked(dialog.showMessageBox).mockClear();

    // quitAndInstall()'s own app.quit(), arriving after the windows closed.
    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('stays armed while the restart is merely deferred, then completes it silently', async () => {
    // The likely macOS path, and the one a previous fix broke.
    // `MacUpdater.quitAndInstall()` quits only `if (this.squirrelDownloadedUpdate)`;
    // otherwise it registers a deferred `update-downloaded` listener and
    // returns with the app alive — the restart is still coming, just later. A
    // mock that simply returns is exactly that branch.
    const { app, dialog } = await getElectronMock();
    const { autoUpdater, autoUpdaterModule, shutdown } = await armUpdateRestart(2);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));

    await autoUpdaterModule.restartToUpdate();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));

    // Deferred is not "did not take". Disarming here is what put the
    // background notice back in the middle of an update.
    expect(autoUpdaterModule.isRestartingToUpdate()).toBe(true);

    // Squirrel finishes seconds later: the windows close, then the quit comes.
    vi.mocked(dialog.showMessageBox).mockClear();
    await app.emit('window-all-closed');
    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    // One decision, one dialog — and it was asked before any of this.
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
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
    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('drops the token when the updater errors, as a rejected Squirrel update does', async () => {
    const { dialog } = await getElectronMock();
    const { autoUpdater, autoUpdaterModule } = await armUpdateRestart(1);
    autoUpdaterModule.setupAutoUpdater(() => null);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    await autoUpdaterModule.restartToUpdate();

    // The macOS shape: quitAndInstall took its deferred branch, then Squirrel
    // rejected the update it had been waiting for.
    autoUpdater.emit('error', new Error('Could not get code signature for running application'));

    expect(autoUpdaterModule.isRestartingToUpdate()).toBe(false);
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
 * The honesty half of the updater overhaul (spec `desktop-updater-overhaul`
 * D1–D3, DOR-1454).
 *
 * Squirrel cannot report an install that failed, so the app writes down what it
 * was promised and judges the promise on the next launch. These cases drive
 * that end to end through the REAL intent file (a throwaway `userData`
 * directory per test — see `electron-mock.ts`), because "did anything actually
 * survive the restart" is the entire question.
 */
describe('install intent and the next-launch verdict (DOR-1454)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Boot the updater as `index.ts` does, with a window present and a chosen running version. */
  async function launch(runningVersion = '0.63.0') {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    app.getVersion = vi.fn(() => runningVersion);
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const intent = await import('../updater-intent');
    const autoUpdaterModule = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    return { app, autoUpdater, autoUpdaterModule, intent, win };
  }

  /** Every `update:status` payload the renderer was sent. */
  function sentStatuses(win: { webContents: { send: ReturnType<typeof vi.fn> } }): unknown[] {
    return win.webContents.send.mock.calls
      .filter(([channel]) => channel === 'update:status')
      .map(([, status]) => status);
  }

  it('says nothing on a machine that has never attempted an install', async () => {
    const { autoUpdaterModule, win } = await launch();

    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    expect(sentStatuses(win)).not.toContainEqual(
      expect.objectContaining({ state: 'install-failed' })
    );
    expect(autoUpdaterModule.getLastUpdateStatus()).toBeNull();
  });

  it('forgets the attempt when the update actually landed', async () => {
    const { autoUpdaterModule, intent, win } = await launch('0.63.0');
    intent.writeUpdateIntent('0.63.0');

    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    expect(intent.readUpdateIntent()).toBeNull();
    expect(sentStatuses(win)).not.toContainEqual(
      expect.objectContaining({ state: 'install-failed' })
    );
  });

  it('forgets the attempt when an even newer version is running (a manual install)', async () => {
    const { autoUpdaterModule, intent, win } = await launch('0.64.0');
    intent.writeUpdateIntent('0.63.0');

    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    expect(intent.readUpdateIntent()).toBeNull();
  });

  it('tells the renderer, warns once, and KEEPS the record when the update did not land', async () => {
    const log = (await import('electron-log')).default;
    const { autoUpdaterModule, intent, win } = await launch('0.58.0');
    intent.writeUpdateIntent('0.63.0');

    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    expect(sentStatuses(win)).toContainEqual({
      state: 'install-failed',
      version: '0.63.0',
      attempts: 1,
    });
    // Kept: it is the record that counts the attempts.
    expect(intent.readUpdateIntent()).toMatchObject({ offeredVersion: '0.63.0', attempts: 1 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toContain('0.63.0');
  });

  it('carries the attempt count through to the card on a second failure', async () => {
    const { autoUpdaterModule, intent, win } = await launch('0.58.0');
    intent.writeUpdateIntent('0.63.0');
    intent.writeUpdateIntent('0.63.0');

    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    expect(sentStatuses(win)).toContainEqual({
      state: 'install-failed',
      version: '0.63.0',
      attempts: 2,
    });
  });

  it('replays a failed install to a renderer that mounts later', async () => {
    // macOS close→reopen: the window that was told is gone, and the fresh React
    // tree learns nothing unless the status was latched.
    const { autoUpdaterModule, intent, win } = await launch('0.58.0');
    intent.writeUpdateIntent('0.63.0');

    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    expect(autoUpdaterModule.getLastUpdateStatus()).toEqual({
      state: 'install-failed',
      version: '0.63.0',
      attempts: 1,
    });
  });

  it('does not let the SAME version re-downloading erase the failure', async () => {
    // What actually happens within minutes of every launch: the updater
    // re-downloads and re-stages the exact version that would not install.
    const { autoUpdater, autoUpdaterModule, intent, win } = await launch('0.58.0');
    intent.writeUpdateIntent('0.63.0');
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    autoUpdater.emit('download-progress', { percent: 80 } as ProgressInfo);
    autoUpdater.emit('update-downloaded', { version: '0.63.0' } as UpdateDownloadedEvent);

    // A renderer mounting now must not be handed "Restart to install" for the
    // one thing restarting cannot fix.
    expect(autoUpdaterModule.getLastUpdateStatus()).toEqual({
      state: 'install-failed',
      version: '0.63.0',
      attempts: 1,
    });
  });

  it('lets a genuinely newer version replace the failure once it has downloaded', async () => {
    const { autoUpdater, autoUpdaterModule, intent, win } = await launch('0.58.0');
    intent.writeUpdateIntent('0.63.0');
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    autoUpdater.emit('update-downloaded', { version: '0.64.0' } as UpdateDownloadedEvent);

    expect(autoUpdaterModule.getLastUpdateStatus()).toEqual({
      state: 'downloaded',
      version: '0.64.0',
    });
  });

  it('records the attempt BEFORE handing off to the installer', async () => {
    const { autoUpdater, autoUpdaterModule, intent, win } = await launch();
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    autoUpdater.emit('update-downloaded', { version: '0.64.0' } as UpdateDownloadedEvent);
    vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
      // Whatever Squirrel does next, the record has to already be on disk:
      // on the branch that quits straight away nothing after this runs.
      expect(intent.readUpdateIntent()).toMatchObject({ offeredVersion: '0.64.0', attempts: 1 });
    });

    await autoUpdaterModule.restartToUpdate();

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(intent.readUpdateIntent()).toMatchObject({ offeredVersion: '0.64.0', attempts: 1 });
  });

  it('counts one restart as ONE attempt, though it passes both recording paths', async () => {
    // The restart records, then `quitAndInstall()`'s own `app.quit()` reaches
    // the quit sequence, which asks again. Two writes would send the card to
    // "Download fresh copy" after a single ordinary failure.
    const { app, autoUpdater, autoUpdaterModule, intent, win } = await launch();
    const quitGuard = await import('../quit-guard');
    quitGuard.resetQuitGuard();
    quitGuard.armQuitGuard({
      countActiveAgents: () => 0,
      getWindow: () => null,
      shutdown: () => Promise.resolve(),
      consumeUpdateRestart: autoUpdaterModule.consumeUpdateRestart,
      recordUpdateInstallIntent: autoUpdaterModule.recordUpdateInstallIntent,
    });
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    autoUpdater.emit('update-downloaded', { version: '0.64.0' } as UpdateDownloadedEvent);

    await autoUpdaterModule.restartToUpdate();
    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(intent.readUpdateIntent()?.attempts).toBe(1);
  });

  it('records the attempt for an ordinary quit that installs on the way out', async () => {
    // `autoInstallOnAppQuit` — the path that finally installed something on the
    // reporting user's machine, and the one nothing ever announced.
    const { app, autoUpdater, autoUpdaterModule, intent, win } = await launch();
    const quitGuard = await import('../quit-guard');
    quitGuard.resetQuitGuard();
    quitGuard.armQuitGuard({
      countActiveAgents: () => 0,
      getWindow: () => null,
      shutdown: () => Promise.resolve(),
      consumeUpdateRestart: autoUpdaterModule.consumeUpdateRestart,
      recordUpdateInstallIntent: autoUpdaterModule.recordUpdateInstallIntent,
    });
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    autoUpdater.emit('update-downloaded', { version: '0.64.0' } as UpdateDownloadedEvent);

    // Nobody clicked restart; this is Cmd+Q.
    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(intent.readUpdateIntent()).toMatchObject({ offeredVersion: '0.64.0', attempts: 1 });
  });

  it('writes nothing when a quit has no update staged', async () => {
    const { app, autoUpdater, autoUpdaterModule, intent, win } = await launch();
    const quitGuard = await import('../quit-guard');
    quitGuard.resetQuitGuard();
    quitGuard.armQuitGuard({
      countActiveAgents: () => 0,
      getWindow: () => null,
      shutdown: () => Promise.resolve(),
      consumeUpdateRestart: autoUpdaterModule.consumeUpdateRestart,
      recordUpdateInstallIntent: autoUpdaterModule.recordUpdateInstallIntent,
    });
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    // Downloading is not staged: there is nothing for the next launch to judge.
    autoUpdater.emit('download-progress', { percent: 40 } as ProgressInfo);

    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(intent.readUpdateIntent()).toBeNull();
  });

  it('stops counting once an error retires the offer, rather than inventing attempts', async () => {
    // The macOS shape: quitAndInstall deferred, then Squirrel refused, and the
    // app is still up. The error replaces the `downloaded` everywhere — the
    // card stops offering a restart, and with nothing staged to point at,
    // neither a second click nor a later quit may invent a further attempt.
    const { app, autoUpdater, autoUpdaterModule, intent, win } = await launch();
    const quitGuard = await import('../quit-guard');
    quitGuard.resetQuitGuard();
    quitGuard.armQuitGuard({
      countActiveAgents: () => 0,
      getWindow: () => null,
      shutdown: () => Promise.resolve(),
      consumeUpdateRestart: autoUpdaterModule.consumeUpdateRestart,
      recordUpdateInstallIntent: autoUpdaterModule.recordUpdateInstallIntent,
    });
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    autoUpdater.emit('update-downloaded', { version: '0.64.0' } as UpdateDownloadedEvent);

    await autoUpdaterModule.restartToUpdate();
    expect(intent.readUpdateIntent()?.attempts).toBe(1);

    autoUpdater.emit('error', new Error('Could not get code signature'));
    expect(autoUpdaterModule.getLastUpdateStatus()).toMatchObject({ state: 'error' });

    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    // The one real attempt stands; the count reflects what was tried.
    expect(intent.readUpdateIntent()?.attempts).toBe(1);
  });

  it('replays the ERROR, not the dead downloaded, after a download that then failed', async () => {
    // The lie this whole change exists to kill, in its last hiding place: the
    // renderer replaces a `downloaded` with a later `error`, so a window
    // recreated by `get-update-status` must not be handed the `downloaded`
    // back. It was, and "Restart to install" returned from the dead.
    const { autoUpdater, autoUpdaterModule, win } = await launch();
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    autoUpdater.emit('update-downloaded', { version: '0.64.0' } as UpdateDownloadedEvent);
    autoUpdater.emit('error', new Error('code signature check failed'));

    expect(autoUpdaterModule.getLastUpdateStatus()).toEqual({
      state: 'error',
      message: 'code signature check failed',
    });
  });

  it('does not strand a stale error once a later check resolves it', async () => {
    // The replay folds exactly as the renderer does, so a transient that the
    // renderer would move on from moves the stored status on too.
    const { autoUpdater, autoUpdaterModule, win } = await launch();
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    autoUpdater.emit('update-downloaded', { version: '0.64.0' } as UpdateDownloadedEvent);
    autoUpdater.emit('error', new Error('offline'));
    autoUpdater.emit('update-not-available', { version: '0.63.0' } as UpdateInfo);

    expect(autoUpdaterModule.getLastUpdateStatus()).toEqual({ state: 'not-available' });
  });

  it('does not offer a native restart for a version already known not to install', async () => {
    // No window (macOS, closed), a judged failure, and the 4-hourly check
    // re-staging the same version for ever. The modal used to appear every
    // time, offering the one action that cannot work.
    const { app, autoUpdater, autoUpdaterModule, intent } = await launch('0.58.0');
    const { dialog } = await getElectronMock();
    intent.writeUpdateIntent('0.63.0');
    autoUpdaterModule.setupAutoUpdater(() => null);
    vi.mocked(dialog.showMessageBox).mockClear();

    autoUpdater.emit('update-downloaded', { version: '0.63.0' } as UpdateDownloadedEvent);
    await new Promise((resolve) => setImmediate(resolve));

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('still offers the native restart once a genuinely newer version is staged', async () => {
    // The suppression is about THIS version, never a blanket silence.
    const { autoUpdater, autoUpdaterModule, intent } = await launch('0.58.0');
    const { dialog } = await getElectronMock();
    intent.writeUpdateIntent('0.63.0');
    autoUpdaterModule.setupAutoUpdater(() => null);
    vi.mocked(dialog.showMessageBox).mockClear();

    autoUpdater.emit('update-downloaded', { version: '0.64.0' } as UpdateDownloadedEvent);

    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ['Restart Now', 'Later'] })
    );
  });

  it('keeps counting attempts across launches, so the count can reach two', async () => {
    // Squirrel re-attempts the staged update on every ordinary quit
    // (`autoInstallOnAppQuit`). Counting only a fresh `downloaded` froze this
    // at 1 for ever, which made the warn line untrue and the >= 2 rule inert.
    const { app, autoUpdaterModule, intent } = await launch('0.58.0');
    const quitGuard = await import('../quit-guard');
    quitGuard.resetQuitGuard();
    quitGuard.armQuitGuard({
      countActiveAgents: () => 0,
      getWindow: () => null,
      shutdown: () => Promise.resolve(),
      consumeUpdateRestart: autoUpdaterModule.consumeUpdateRestart,
      recordUpdateInstallIntent: autoUpdaterModule.recordUpdateInstallIntent,
    });
    // Launch 2: the first attempt is on record and judged a failure.
    intent.writeUpdateIntent('0.63.0');
    autoUpdaterModule.setupAutoUpdater(() => null);
    expect(intent.readUpdateIntent()?.attempts).toBe(1);

    // The person quits; Squirrel tries the staged copy again on the way out.
    await app.emit('before-quit', { preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(intent.readUpdateIntent()).toMatchObject({ offeredVersion: '0.63.0', attempts: 2 });
  });

  it('records nothing in an unpackaged build, which has no installer to run', async () => {
    const { app, autoUpdaterModule, intent, win } = await launch();
    app.isPackaged = false;

    autoUpdaterModule.recordUpdateInstallIntent();

    expect(intent.readUpdateIntent()).toBeNull();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
