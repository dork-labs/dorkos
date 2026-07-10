import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-updater', () => import('./electron-updater-mock'));

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

  it('update-downloaded: Restart Now (response 0) calls quitAndInstall', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    autoUpdater.emit('update-downloaded', { version: '2.0.0' } as UpdateDownloadedEvent);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ buttons: ['Restart Now', 'Later'] })
    );

    await vi.waitFor(() => {
      expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  it('update-downloaded: Later (response 1) does not call quitAndInstall', async () => {
    const { app, BrowserWindow, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    const { autoUpdater, resetAutoUpdaterMock } = await getAutoUpdaterMock();
    resetAutoUpdaterMock();

    const { setupAutoUpdater } = await import('../auto-updater');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    setupAutoUpdater(() => win as unknown as Electron.BrowserWindow);

    autoUpdater.emit('update-downloaded', { version: '2.0.0' } as UpdateDownloadedEvent);

    await vi.waitFor(() => {
      expect(dialog.showMessageBox).toHaveBeenCalled();
    });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
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
