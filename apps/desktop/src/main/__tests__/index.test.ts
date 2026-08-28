import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
// Windows are stubbed, but `isWebLink` is kept real: the `open-external` tests
// below assert that the bridge enforces the shell's actual outbound policy, and
// a hand-written copy of it here would keep passing after the real one changed.
vi.mock('../window-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../window-manager')>()),
  createWindow: vi.fn(),
  makeRendererUrlAccessor: vi.fn(() => () => undefined),
}));
vi.mock('../window-state', () => ({ watchDisplayChanges: vi.fn() }));
vi.mock('../server-process', () => ({
  startServer: vi.fn(async () => 4242),
  stopServer: vi.fn(async () => undefined),
  getServerPort: vi.fn(() => 4242),
}));
vi.mock('../menu', () => ({ setupMenu: vi.fn(), setupDockMenu: vi.fn() }));
vi.mock('../about', () => ({ setupAboutPanel: vi.fn() }));
vi.mock('../auto-updater', () => ({
  setupAutoUpdater: vi.fn(),
  restartToUpdate: vi.fn(async () => undefined),
  getLastUpdateStatus: vi.fn(() => null),
  isRestartingToUpdate: vi.fn(() => false),
  consumeUpdateRestart: vi.fn(() => false),
  recordUpdateInstallIntent: vi.fn(),
}));
// Reading the bundle on disk is its own suite's job; here the question is only
// whether the two moments a person expects a new version are wired to it.
vi.mock('../updater/manual-overwrite', () => ({
  checkForManualOverwrite: vi.fn(async () => undefined),
}));
vi.mock('../tray', () => ({
  setupTray: vi.fn(),
  setTrayActivity: vi.fn(),
  hasTray: vi.fn(() => true),
}));
// The real watcher opens a socket to a server that does not exist here; its own
// suite covers the wire format.
vi.mock('../agent-activity', () => ({
  watchAgentActivity: vi.fn(() => ({ stop: vi.fn() })),
  getActiveAgentCount: vi.fn(() => 0),
}));
vi.mock('../background-notice', () => ({
  announceBackgroundRunning: vi.fn(async () => undefined),
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
  // `../index` only registers the `open-url` listener when
  // `process.platform === 'darwin'` (it is a macOS-only Electron event), and it
  // decides that at import time. Without pinning the platform these tests emit
  // `open-url` at a listener that was never registered, so every assertion
  // about it reads zero calls.
  //
  // That made the four of them pass on a developer Mac and fail everywhere
  // else. Nothing caught it, because until DOR-544 no CI job ran the tests —
  // the first CI run of this suite, on ubuntu-latest, was also the first time
  // anyone saw them red. The sibling block below pins `win32` for the argv
  // delivery path for the same reason.
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
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

/**
 * Noticing an app replaced on disk while it kept running (DOR-1455, decision 8).
 *
 * DorkOS survives its window closing, so a drag-install leaves the OLD process
 * running and the single-instance lock turns "open the new one" into "focus the
 * old one". These are the two moments a person plainly expects the version they
 * just installed.
 */
describe('a newer DorkOS installed while this one runs', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('looks when a second launch is handed to the running instance', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const manualOverwrite = await import('../updater/manual-overwrite');
    vi.mocked(manualOverwrite.checkForManualOverwrite).mockClear();

    await import('../index');
    await app.emit('second-instance', ['/Applications/DorkOS.app']);

    expect(manualOverwrite.checkForManualOverwrite).toHaveBeenCalledTimes(1);
  });

  it('looks when the window is focused', async () => {
    const { app, BrowserWindow, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const windowManager = await import('../window-manager');
    const win = new BrowserWindow({ width: 1200, height: 800 });
    vi.mocked(windowManager.createWindow)
      .mockReset()
      .mockReturnValue(win as unknown as Electron.BrowserWindow);

    const manualOverwrite = await import('../updater/manual-overwrite');
    vi.mocked(manualOverwrite.checkForManualOverwrite).mockClear();

    await import('../index');
    await app.emit('ready');
    expect(manualOverwrite.checkForManualOverwrite).not.toHaveBeenCalled();

    await win.emit('focus');

    expect(manualOverwrite.checkForManualOverwrite).toHaveBeenCalledTimes(1);
  });
});

describe('keeping DorkOS running in the background (DOR-538)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Boot the app with one tracked window and hand it back. */
  async function boot(): Promise<{
    app: Awaited<ReturnType<typeof getElectronMock>>['app'];
    win: Awaited<ReturnType<typeof getElectronMock>>['BrowserWindow']['prototype'];
  }> {
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
    return { app, win };
  }

  it('does not quit when the last window closes — there is a tray to come back from', async () => {
    const tray = await import('../tray');
    vi.mocked(tray.hasTray).mockReturnValue(true);
    const notice = await import('../background-notice');
    const { app } = await boot();

    await app.emit('window-all-closed');

    expect(app.quit).not.toHaveBeenCalled();
    expect(notice.announceBackgroundRunning).toHaveBeenCalledTimes(1);
  });

  it('quits when the last window closes and there is no tray to come back from', async () => {
    const tray = await import('../tray');
    vi.mocked(tray.hasTray).mockReturnValue(false);
    const notice = await import('../background-notice');
    vi.mocked(notice.announceBackgroundRunning).mockClear();
    const { app } = await boot();

    await app.emit('window-all-closed');

    expect(app.quit).toHaveBeenCalledTimes(1);
    // Nothing to reassure them about: the app really did go.
    expect(notice.announceBackgroundRunning).not.toHaveBeenCalled();
  });

  it('stays silent when quitAndInstall closes the windows on its way to an update restart', async () => {
    // quitAndInstall() "will close all application windows first, and
    // automatically call app.quit() after all windows have been closed" — so
    // this event fires on the update path exactly as if a person had closed
    // the last window. Left unguarded it showed "DorkOS is still running", with
    // a Quit button, mid-update, and burnt the one-time notice for good.
    const autoUpdater = await import('../auto-updater');
    vi.mocked(autoUpdater.isRestartingToUpdate).mockReturnValue(true);
    const tray = await import('../tray');
    vi.mocked(tray.hasTray).mockReturnValue(true);
    const notice = await import('../background-notice');
    vi.mocked(notice.announceBackgroundRunning).mockClear();
    const { app } = await boot();

    await app.emit('window-all-closed');

    expect(notice.announceBackgroundRunning).not.toHaveBeenCalled();
    // No quit either: quitAndInstall's own app.quit() is what finishes this.
    expect(app.quit).not.toHaveBeenCalled();
    vi.mocked(autoUpdater.isRestartingToUpdate).mockReturnValue(false);
  });

  it('still quits with no tray, even mid-update — that state must be unreachable', async () => {
    // The severe half of the update-restart bug: gating this branch on a flag
    // another module owns meant a stuck flag could leave the app running with
    // no window AND no tray. The flag may silence the notice; it may never
    // stop the quit.
    const autoUpdater = await import('../auto-updater');
    vi.mocked(autoUpdater.isRestartingToUpdate).mockReturnValue(true);
    const tray = await import('../tray');
    vi.mocked(tray.hasTray).mockReturnValue(false);
    const { app } = await boot();

    await app.emit('window-all-closed');

    expect(app.quit).toHaveBeenCalledTimes(1);
    vi.mocked(autoUpdater.isRestartingToUpdate).mockReturnValue(false);
  });

  it('hands the quit guard a token it can spend, not a flag it can only read', async () => {
    const autoUpdater = await import('../auto-updater');
    const quitGuard = await import('../quit-guard');
    const armSpy = vi.spyOn(quitGuard, 'armQuitGuard');
    await boot();

    const [options] = armSpy.mock.calls[0];
    expect(options.consumeUpdateRestart).toBe(autoUpdater.consumeUpdateRestart);
    armSpy.mockRestore();
  });

  it('sets up the tray with a way back to the window and to the activity view', async () => {
    const tray = await import('../tray');
    vi.mocked(tray.setupTray).mockClear();
    const { win } = await boot();
    const navigation = await import('../navigation');
    navigation.resolvePendingNavigate(win.webContents.id);

    const [options] = vi.mocked(tray.setupTray).mock.calls[0];
    options.showWindow();
    expect(win.focus).toHaveBeenCalledTimes(1);

    options.openActivity();
    expect(win.webContents.send).toHaveBeenCalledWith('navigate', navigation.ACTIVITY_ROUTE);
  });

  it('feeds the tray from the server event stream, reading the port through the supervisor', async () => {
    const activity = await import('../agent-activity');
    vi.mocked(activity.watchAgentActivity).mockClear();
    const tray = await import('../tray');
    await boot();

    const [options] = vi.mocked(activity.watchAgentActivity).mock.calls[0];
    expect(options.getPort()).toBe(4242);
    expect(options.onChange).toBe(tray.setTrayActivity);
  });
});

describe('the open-external bridge', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Invoke the `open-external` handler `../index` registered. */
  async function openExternal(url: unknown): Promise<void> {
    const { ipcMain } = await getElectronMock();
    const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === 'open-external');
    if (!call) throw new Error('no ipcMain.handle registered for "open-external"');
    const handler = call[1] as (event: unknown, url: unknown) => Promise<void>;
    await handler({}, url);
  }

  async function loadShell(): Promise<void> {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);
    await import('../index');
  }

  it("hands the app's own address to the system browser", async () => {
    await loadShell();
    const { shell } = await getElectronMock();

    // The case the bridge exists for. `window.open` at this URL is claimed by
    // the window-open handler and becomes a second cockpit window, so Settings
    // → Server's "open in your browser" would not leave the app without it.
    await openExternal('http://localhost:4242');

    expect(shell.openExternal).toHaveBeenCalledWith('http://localhost:4242');
  });

  it('refuses anything the shell would not open from a link', async () => {
    await loadShell();
    const { shell } = await getElectronMock();

    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'dorkos://agents',
      'mailto:someone@example.com',
      '',
      42,
      null,
      undefined,
    ]) {
      await openExternal(url);
    }

    expect(shell.openExternal).not.toHaveBeenCalled();
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
    // An opaque failure gets the generic advice, because trying again really
    // may work and the log really is where to look.
    expect(message).toMatch(/try restarting the app/i);
    expect(message).toMatch(/Library\/Logs/);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // No window, no menu/updater setup — the app must not proceed past the
    // failed server start into a half-initialized, windowless state.
    expect(windowManager.createWindow).not.toHaveBeenCalled();
  });

  it('drops the "try restarting" advice when the failure already says what to do', async () => {
    const { app, dialog, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.requestSingleInstanceLock = vi.fn(() => true);

    const { PortUnavailableError } = await import('../server-port');
    const refusal =
      'DorkOS is set to use port 5000, and something else on this computer already has it. ' +
      'Quit whatever is using port 5000 and open DorkOS again.';
    const serverProcess = await import('../server-process');
    vi.mocked(serverProcess.startServer).mockRejectedValueOnce(new PortUnavailableError(refusal));

    await import('../index');
    await app.emit('ready');

    const [, message] = vi.mocked(dialog.showErrorBox).mock.calls[0];
    expect(message).toBe(refusal);
    // "Try restarting the app" is not merely unhelpful for a pinned port that
    // is still taken next launch — it contradicts the sentence underneath it,
    // which is how people learn to stop reading these boxes.
    expect(message).not.toMatch(/try restarting the app/i);
  });
});
