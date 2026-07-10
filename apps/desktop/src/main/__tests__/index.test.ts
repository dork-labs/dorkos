import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('../window-manager', () => ({ createWindow: vi.fn() }));
vi.mock('../server-process', () => ({
  startServer: vi.fn(async () => 4242),
  stopServer: vi.fn(async () => undefined),
  getServerPort: vi.fn(() => 4242),
}));
vi.mock('../menu', () => ({ setupMenu: vi.fn(), setupDockMenu: vi.fn() }));
vi.mock('../about', () => ({ setupAboutPanel: vi.fn() }));

/**
 * `vi.mock('electron', factory)` memoizes its result for the whole test
 * file — `vi.resetModules()` re-evaluates `../index` fresh per test, but it
 * does not re-invoke the mock factory. Fetching the mock state through the
 * `'electron'` specifier (rather than importing `./electron-mock` directly)
 * guarantees the same singleton the source modules resolve to.
 */
async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('./electron-mock');
}

describe('single-instance lock (A1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('quits immediately and never starts the server when the lock is denied', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => false);

    const serverProcess = await import('../server-process');
    await import('../index');

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(serverProcess.startServer).not.toHaveBeenCalled();
  });

  it('restores a minimized window and focuses it when a second instance launches', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const mockWindow = new BrowserWindow({ width: 1200, height: 800 });
    mockWindow.isMinimized = vi.fn(() => true);
    vi.mocked(windowManager.createWindow).mockReturnValue(
      mockWindow as unknown as Electron.BrowserWindow
    );

    await import('../index');
    await app.emit('ready');
    await app.emit('second-instance');

    expect(mockWindow.restore).toHaveBeenCalledTimes(1);
    expect(mockWindow.focus).toHaveBeenCalledTimes(1);
  });

  it('focuses without restoring when the existing window is not minimized', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const mockWindow = new BrowserWindow({ width: 1200, height: 800 });
    mockWindow.isMinimized = vi.fn(() => false);
    vi.mocked(windowManager.createWindow).mockReturnValue(
      mockWindow as unknown as Electron.BrowserWindow
    );

    await import('../index');
    await app.emit('ready');
    await app.emit('second-instance');

    expect(mockWindow.restore).not.toHaveBeenCalled();
    expect(mockWindow.focus).toHaveBeenCalledTimes(1);
  });

  it('recreates the window on second-instance after the window was closed', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const firstWindow = new BrowserWindow({ width: 1200, height: 800 });
    const secondWindow = new BrowserWindow({ width: 1200, height: 800 });
    // The window-manager mock is memoized across tests — reset call counts
    // so the assertions below only see this test's calls.
    vi.mocked(windowManager.createWindow)
      .mockReset()
      .mockReturnValueOnce(firstWindow as unknown as Electron.BrowserWindow)
      .mockReturnValueOnce(secondWindow as unknown as Electron.BrowserWindow);

    await import('../index');
    await app.emit('ready');

    // macOS: the window closes but the app keeps running.
    await firstWindow.emit('closed');
    await app.emit('second-instance');

    expect(windowManager.createWindow).toHaveBeenCalledTimes(2);
    // The stale reference must not be touched after close.
    expect(firstWindow.isMinimized).not.toHaveBeenCalled();
    expect(firstWindow.focus).not.toHaveBeenCalled();
  });

  it('recreates the window on second-instance when the tracked window is destroyed', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const destroyedWindow = new BrowserWindow({ width: 1200, height: 800 });
    destroyedWindow.isDestroyed = vi.fn(() => true);
    // The window-manager mock is memoized across tests — reset call counts
    // so the assertions below only see this test's calls.
    vi.mocked(windowManager.createWindow)
      .mockReset()
      .mockReturnValue(destroyedWindow as unknown as Electron.BrowserWindow);

    await import('../index');
    await app.emit('ready');
    await app.emit('second-instance');

    // Destroyed window: never touched; a replacement is created instead.
    expect(destroyedWindow.isMinimized).not.toHaveBeenCalled();
    expect(destroyedWindow.focus).not.toHaveBeenCalled();
    expect(windowManager.createWindow).toHaveBeenCalledTimes(2);
  });
});
