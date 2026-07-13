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
vi.mock('../auto-updater', () => ({
  setupAutoUpdater: vi.fn(),
  restartToUpdate: vi.fn(),
  getLastUpdateStatus: vi.fn(() => null),
}));

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

describe('Windows/Linux deep links (argv delivery)', () => {
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

  it('a warm second-instance carrying a dorkos:// arg routes the deep link', async () => {
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

    // Renderer marks itself ready (as the client hook does on mount) so the
    // deep link takes the hot path rather than queuing.
    const handler = await getHandler('get-pending-navigate');
    handler({ sender: win.webContents } as unknown as Electron.IpcMainInvokeEvent);

    // Windows/Linux hand the second instance's command line to this event.
    await app.emit('second-instance', {}, [
      'C:\\Program Files\\DorkOS\\DorkOS.exe',
      'dorkos://session?id=7',
    ]);

    expect(win.webContents.send).toHaveBeenCalledWith('navigate', '/session?id=7');
  });

  it('a warm second-instance with argv but no deep link just focuses the window', async () => {
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

    await app.emit('second-instance', {}, ['C:\\DorkOS\\DorkOS.exe', '--enable-logging']);

    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('a cold-start deep link in process.argv is queued and delivered once the window is ready', async () => {
    const originalPlatform = process.platform;
    const originalArgv = process.argv;
    // The cold-start argv scan only runs off macOS; pretend we booted on
    // Windows with a deep link on the command line.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.argv = ['C:\\Program Files\\DorkOS\\DorkOS.exe', 'dorkos://agents/42'];
    try {
      const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
      resetElectronMock();
      app.requestSingleInstanceLock = vi.fn(() => true);

      const windowManager = await import('../window-manager');
      const win = new BrowserWindow({ width: 1200, height: 800 });
      vi.mocked(windowManager.createWindow)
        .mockReset()
        .mockReturnValue(win as unknown as Electron.BrowserWindow);

      // Importing index runs the cold-start scan immediately (before 'ready'):
      // no window/server exists yet, so the path must be queued, not sent.
      await import('../index');
      expect(win.webContents.send).not.toHaveBeenCalled();

      // The window is created once the app finishes starting up, and the
      // renderer's on-mount pull picks up the queued path (read-once).
      await app.emit('ready');
      const handler = await getHandler('get-pending-navigate');
      expect(handler({ sender: win.webContents } as unknown as Electron.IpcMainInvokeEvent)).toBe(
        '/agents/42'
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      process.argv = originalArgv;
    }
  });

  it('does not register the macOS open-url handler when running off macOS', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.argv = ['C:\\DorkOS\\DorkOS.exe'];
    try {
      const { app, resetElectronMock } = await getElectronMock();
      resetElectronMock();
      app.requestSingleInstanceLock = vi.fn(() => true);
      // `app.on` is a shared vi.fn the mock never re-creates, so its call log
      // carries over from earlier tests — clear it so this assertion only sees
      // the registrations `../index` makes on this (Windows) import.
      vi.mocked(app.on).mockClear();

      await import('../index');

      const registeredEvents = vi.mocked(app.on).mock.calls.map(([event]) => event);
      expect(registeredEvents).not.toContain('open-url');
      // The cross-platform pieces are still wired.
      expect(registeredEvents).toContain('second-instance');
      expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('dorkos');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

describe('update IPC handlers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Look up the handler `../index` registered for `ipcMain.on(channel, ...)`. */
  async function getOnHandler(channel: string): Promise<(...args: unknown[]) => unknown> {
    const { ipcMain } = await getElectronMock();
    const call = vi.mocked(ipcMain.on).mock.calls.find(([ch]) => ch === channel);
    if (!call) throw new Error(`no ipcMain.on registered for "${channel}"`);
    return call[1] as (...args: unknown[]) => unknown;
  }

  /** Look up the handler `../index` registered for `ipcMain.handle(channel, ...)`. */
  async function getInvokeHandler(
    channel: string
  ): Promise<(event: Electron.IpcMainInvokeEvent) => unknown> {
    const { ipcMain } = await getElectronMock();
    const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
    if (!call) throw new Error(`no ipcMain.handle registered for "${channel}"`);
    return call[1] as (event: Electron.IpcMainInvokeEvent) => unknown;
  }

  it('update:restart routes to restartToUpdate', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const autoUpdater = await import('../auto-updater');
    await import('../index');

    const handler = await getOnHandler('update:restart');
    handler();

    expect(autoUpdater.restartToUpdate).toHaveBeenCalledTimes(1);
  });

  it('get-update-status replays the last status to the tracked renderer, and rejects a stray sender', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    vi.mocked(windowManager.createWindow)
      .mockReset()
      .mockReturnValue(win as unknown as Electron.BrowserWindow);

    const autoUpdater = await import('../auto-updater');
    vi.mocked(autoUpdater.getLastUpdateStatus).mockReturnValue({
      state: 'downloaded',
      version: '2.0.0',
    });

    await import('../index');
    await app.emit('ready');

    const handler = await getInvokeHandler('get-update-status');

    // The tracked renderer recovers the downloaded status on mount.
    expect(handler({ sender: win.webContents } as unknown as Electron.IpcMainInvokeEvent)).toEqual({
      state: 'downloaded',
      version: '2.0.0',
    });
    // A stray webContents (devtools, an auxiliary window) gets nothing.
    expect(handler({ sender: { id: 9999 } } as unknown as Electron.IpcMainInvokeEvent)).toBeNull();
  });
});

describe('server start failure', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('shows an error dialog and quits instead of sitting windowless when startServer rejects', async () => {
    const { app, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const serverProcess = await import('../server-process');
    vi.mocked(serverProcess.startServer).mockRejectedValueOnce(new Error('utility process exited'));

    const windowManager = await import('../window-manager');
    vi.mocked(windowManager.createWindow).mockClear();

    await import('../index');
    await app.emit('ready');

    expect(dialog.showErrorBox).toHaveBeenCalledTimes(1);
    const [title, message] = vi.mocked(dialog.showErrorBox).mock.calls[0];
    expect(title).toMatch(/couldn't start/i);
    expect(message).toContain('utility process exited');
    expect(app.quit).toHaveBeenCalledTimes(1);
    // No window, no menu/updater setup — the app must not proceed past the
    // failed server start into a half-initialized, windowless state.
    expect(windowManager.createWindow).not.toHaveBeenCalled();
  });
});
