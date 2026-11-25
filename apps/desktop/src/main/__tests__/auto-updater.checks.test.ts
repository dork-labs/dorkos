import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import {
  getAutoUpdaterMock,
  getElectronMock,
  getMainLog,
  getUpdaterLog,
} from './auto-updater.fixtures';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-updater', () => import('./electron-updater-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

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
    expect(send).toHaveBeenCalledWith('update:status', {
      state: 'downloading',
      percent: 42,
      version: '2.0.0',
    });
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
});

/**
 * DOR-4846: the card names the real version while it downloads, and a stopped
 * download offers a retry. Neither progress nor an error says which version it
 * is about, so the main process tags both with the one `update-available` named.
 */
describe('download progress and download errors carry the version', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Boot the updater packaged, with a window, and clear what it sent. */
  async function bootPackaged() {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    app.getVersion = vi.fn(() => '0.138.0');
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const autoUpdaterModule = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    const sent = () =>
      win.webContents.send.mock.calls
        .filter(([channel]: unknown[]) => channel === 'update:status')
        .map(([, status]: unknown[]) => status);
    return { app, autoUpdater, autoUpdaterModule, sent };
  }

  const progress = (percent: number) =>
    ({ percent, transferred: percent * 10, total: 1000, bytesPerSecond: 100 }) as ProgressInfo;

  it('names the version update-available announced on every progress report', async () => {
    const { autoUpdater, sent } = await bootPackaged();

    autoUpdater.emit('update-available', { version: '0.139.0' } as UpdateInfo);
    autoUpdater.emit('download-progress', progress(42));

    expect(sent()).toContainEqual({ state: 'downloading', percent: 42, version: '0.139.0' });
  });

  it('names the version on an error that stopped its download', async () => {
    const { autoUpdater, autoUpdaterModule, sent } = await bootPackaged();

    autoUpdater.emit('update-available', { version: '0.139.0' } as UpdateInfo);
    autoUpdater.emit('download-progress', progress(10));
    autoUpdater.emit('error', new Error('net::ERR_CONNECTION_RESET'));

    expect(sent().at(-1)).toEqual({
      state: 'error',
      message: 'net::ERR_CONNECTION_RESET',
      version: '0.139.0',
    });
    // And the replay a reopened window starts from says the same.
    expect(autoUpdaterModule.getLastUpdateStatus()).toEqual(sent().at(-1));
  });

  it('retries with a fresh check, and keeps a failed retry about the same version', async () => {
    const { autoUpdater, autoUpdaterModule, sent } = await bootPackaged();
    autoUpdater.emit('update-available', { version: '0.139.0' } as UpdateInfo);
    autoUpdater.emit('error', new Error('net::ERR_CONNECTION_RESET'));
    vi.mocked(autoUpdater.checkForUpdates).mockClear();

    autoUpdaterModule.retryUpdateDownload();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    // Still offline: the retry's own check fails before anything is found.
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('error', new Error('getaddrinfo ENOTFOUND'));

    expect(sent().at(-1)).toEqual({
      state: 'error',
      message: 'getaddrinfo ENOTFOUND',
      version: '0.139.0',
    });
  });
});

/**
 * DOR-4847: the updater writes to its own file. Its lines used to share
 * `main.log`, whose rotation took the evidence of a missing update with it.
 */
describe('the updater log', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Boot the updater packaged, with a window, and clear both log doubles. */
  async function bootPackaged() {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    app.getVersion = vi.fn(() => '0.138.0');
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();
    const { resetLogMock } = (await import('electron-log')) as unknown as typeof import('./electron-log-mock'); // prettier-ignore
    resetLogMock();
    const mainLog = await getMainLog();
    const updaterLog = await getUpdaterLog();

    const autoUpdaterModule = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);
    vi.mocked(dialog.showMessageBox).mockClear();
    return { autoUpdater, autoUpdaterModule, dialog, mainLog, updaterLog };
  }

  /** Every line a logger double received at `level`, as text. */
  function lines(logger: { info: unknown }, level: 'info' | 'warn' | 'error' = 'info'): string[] {
    const fn = (logger as Record<string, (...args: unknown[]) => void>)[level]!;
    return vi.mocked(fn).mock.calls.map((args) => args.map(String).join(' '));
  }

  it('hands electron-updater the updater logger, not the main one', async () => {
    const { autoUpdater, mainLog, updaterLog } = await bootPackaged();

    expect(autoUpdater.logger).toBe(updaterLog);
    expect(autoUpdater.logger).not.toBe(mainLog);
  });

  it('logs check, available, progress, downloaded and error to the updater log only', async () => {
    const { autoUpdater, mainLog, updaterLog } = await bootPackaged();
    vi.mocked(mainLog.info).mockClear();

    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-available', { version: '0.139.0' } as UpdateInfo);
    autoUpdater.emit('download-progress', {
      percent: 42.5,
      transferred: 425,
      total: 1000,
      bytesPerSecond: 100,
    } as ProgressInfo);
    autoUpdater.emit('update-downloaded', { version: '0.139.0' } as UpdateDownloadedEvent);
    autoUpdater.emit('error', new Error('network down'));

    const info = lines(updaterLog);
    for (const fragment of [
      'Checking for an update (running 0.138.0)',
      'Update available: 0.139.0',
      'Downloading: 42% (425 of 1000 bytes',
      'Downloaded 0.139.0',
    ]) {
      expect(info.some((line) => line.includes(fragment))).toBe(true);
    }
    expect(lines(updaterLog, 'error').some((line) => line.includes('network down'))).toBe(true);
    expect(mainLog.info).not.toHaveBeenCalled();
    expect(mainLog.error).not.toHaveBeenCalled();
  });
});
