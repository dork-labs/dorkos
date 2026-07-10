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
vi.mock('../auto-updater', () => ({ setupAutoUpdater: vi.fn() }));

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

describe('dorkos:// deep links (D2) and the pending-navigation handoff (D3)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Look up the handler `../index` registered for `ipcMain.handle(channel, ...)`. */
  async function getHandler(
    channel: string
  ): Promise<(event: Electron.IpcMainInvokeEvent) => unknown> {
    const { ipcMain } = await getElectronMock();
    const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
    if (!call) throw new Error(`no ipcMain.handle registered for "${channel}"`);
    return call[1] as (event: Electron.IpcMainInvokeEvent) => unknown;
  }

  it('registers dorkos:// as the default protocol client at startup', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    await import('../index');

    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('dorkos');
  });

  it('a cold-start open-url (before any window) queues the path; it is delivered once the window is ready', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    vi.mocked(windowManager.createWindow)
      .mockReset()
      .mockReturnValue(win as unknown as Electron.BrowserWindow);

    await import('../index');

    // Electron can deliver `open-url` before 'ready' on a cold-start deep
    // link — no window or server exists yet, so this must not throw and
    // must not attempt an immediate send.
    const preventDefault = vi.fn();
    await app.emit('open-url', { preventDefault }, 'dorkos://agents');
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).not.toHaveBeenCalled();

    // The window is created once the app finishes starting up.
    await app.emit('ready');

    // The renderer's on-mount pull picks up the path that was queued
    // before it existed. Read-once: a second pull returns null.
    const handler = await getHandler('get-pending-navigate');
    expect(handler({ sender: win.webContents } as unknown as Electron.IpcMainInvokeEvent)).toBe(
      '/agents'
    );
    expect(
      handler({ sender: win.webContents } as unknown as Electron.IpcMainInvokeEvent)
    ).toBeNull();
  });

  it('open-url with an already-ready window sends the navigate IPC immediately', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    vi.mocked(windowManager.createWindow)
      .mockReset()
      .mockReturnValue(win as unknown as Electron.BrowserWindow);

    await import('../index');
    await app.emit('ready');

    // Simulate the client hook's on-mount pull, which marks this window's
    // renderer ready even though nothing is pending yet.
    const handler = await getHandler('get-pending-navigate');
    handler({ sender: win.webContents } as unknown as Electron.IpcMainInvokeEvent);

    const preventDefault = vi.fn();
    await app.emit('open-url', { preventDefault }, 'dorkos://session?id=42');

    expect(win.webContents.send).toHaveBeenCalledWith('navigate', '/session?id=42');
  });

  it('ignores get-pending-navigate from a sender that is not the tracked main window', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    vi.mocked(windowManager.createWindow)
      .mockReset()
      .mockReturnValue(win as unknown as Electron.BrowserWindow);

    await import('../index');
    await app.emit('ready');

    // Queue a path (the renderer hasn't marked readiness yet, so it queues).
    await app.emit('open-url', { preventDefault: vi.fn() }, 'dorkos://agents');

    const handler = await getHandler('get-pending-navigate');
    // A stray webContents (devtools, a future auxiliary window) must not
    // mark readiness or steal the pending path.
    expect(handler({ sender: { id: 9999 } } as unknown as Electron.IpcMainInvokeEvent)).toBeNull();
    // The tracked window's renderer still drains the queued path.
    expect(handler({ sender: win.webContents } as unknown as Electron.IpcMainInvokeEvent)).toBe(
      '/agents'
    );
  });

  it('a malformed/unknown deep link just focuses the existing window', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    vi.mocked(windowManager.createWindow)
      .mockReset()
      .mockReturnValue(win as unknown as Electron.BrowserWindow);

    await import('../index');
    await app.emit('ready');

    const preventDefault = vi.fn();
    await app.emit('open-url', { preventDefault }, 'https://not-dorkos.example');

    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
