import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import { getAutoUpdaterMock, getElectronMock, getUpdaterLog } from './auto-updater.fixtures';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-updater', () => import('./electron-updater-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));
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

    // `vi.mock(..., factory)` is memoized for the whole file, so the log double
    // is one object across every test here and its calls accumulate. Cases below
    // count warn lines, so this clears them per launch.
    const log = await getUpdaterLog();
    for (const level of [log.info, log.warn, log.error]) vi.mocked(level).mockClear();

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

  it('forgets the attempt when the update actually landed', async () => {
    const { autoUpdaterModule, intent, win } = await launch('0.63.0');
    intent.writeUpdateIntent('0.63.0');

    autoUpdaterModule.setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    expect(intent.readUpdateIntent()).toBeNull();
    expect(sentStatuses(win)).not.toContainEqual(
      expect.objectContaining({ state: 'install-failed' })
    );
  });

  it('tells the renderer, warns once, and KEEPS the record when the update did not land', async () => {
    const log = await getUpdaterLog();
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
});
