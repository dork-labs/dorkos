import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findDeepLinkArg, parseDeepLink } from '../navigation';

vi.mock('electron', () => import('./electron-mock'));

describe('sendNavigate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the navigate channel with the given path', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { sendNavigate } = await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    sendNavigate(win as unknown as Electron.BrowserWindow, '/agents');

    expect(win.webContents.send).toHaveBeenCalledWith('navigate', '/agents');
  });

  it('is a no-op when the window is null', async () => {
    const { resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { sendNavigate } = await import('../navigation');

    expect(() => sendNavigate(null, '/agents')).not.toThrow();
  });

  it('is a no-op when the window is destroyed', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { sendNavigate } = await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    win.isDestroyed = vi.fn(() => true);
    sendNavigate(win as unknown as Electron.BrowserWindow, '/agents');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

describe('parseDeepLink', () => {
  it.each([
    ['dorkos://agents', '/agents'],
    ['dorkos://agents/', '/agents'],
    ['dorkos://agents/123', '/agents/123'],
    ['dorkos://session?id=x', '/session?id=x'],
    ['dorkos://agents?a=1&b=2', '/agents?a=1&b=2'],
    ['dorkos://AGENTS', '/AGENTS'],
  ])('maps %s to %s', (url, expected) => {
    expect(parseDeepLink(url)).toBe(expected);
  });

  it.each([
    ['https://agents', 'wrong scheme'],
    ['dorkos://', 'empty host'],
    ['dorkos:', 'empty host, no authority'],
    ['dorkos:///leadingslash', 'empty host with path'],
    ['not-a-url', 'unparseable input'],
    ['', 'empty string'],
  ])('rejects %s (%s) as null', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });
});

describe('findDeepLinkArg (Windows/Linux argv delivery)', () => {
  it('finds a dorkos:// URL among a typical Windows cold-start argv', () => {
    expect(findDeepLinkArg(['C:\\Program Files\\DorkOS\\DorkOS.exe', 'dorkos://agents/123'])).toBe(
      'dorkos://agents/123'
    );
  });

  it('finds the URL regardless of its position in argv', () => {
    expect(findDeepLinkArg(['dorkos://session?id=x', '--some-flag'])).toBe('dorkos://session?id=x');
  });

  it('returns the first dorkos:// URL when several are present', () => {
    expect(findDeepLinkArg(['app.exe', 'dorkos://a', 'dorkos://b'])).toBe('dorkos://a');
  });

  it('returns null for an ordinary launch with no deep link', () => {
    expect(findDeepLinkArg(['C:\\DorkOS\\DorkOS.exe', '--enable-logging'])).toBeNull();
  });

  it('returns null for an empty argv', () => {
    expect(findDeepLinkArg([])).toBeNull();
  });

  it('ignores a non-dorkos scheme', () => {
    expect(findDeepLinkArg(['app.exe', 'https://dorkos.ai'])).toBeNull();
  });
});

describe('requestNavigate / resolvePendingNavigate (pending-navigation handoff)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('sends immediately when a live window has already signaled readiness', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { requestNavigate, resolvePendingNavigate } = await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    // Renderer signals readiness (as the client hook does on mount).
    resolvePendingNavigate(win.webContents.id);

    const ensureWindow = vi.fn();
    requestNavigate(() => win as unknown as Electron.BrowserWindow, ensureWindow, '/agents');

    expect(win.webContents.send).toHaveBeenCalledWith('navigate', '/agents');
    expect(ensureWindow).toHaveBeenCalledTimes(1);
  });

  it('queues the path and ensures a window when no window exists yet', async () => {
    const { resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { requestNavigate, resolvePendingNavigate } = await import('../navigation');

    const ensureWindow = vi.fn();
    requestNavigate(() => null, ensureWindow, '/agents');

    expect(ensureWindow).toHaveBeenCalledTimes(1);
    // Delivered once the renderer signals readiness and pulls it.
    expect(resolvePendingNavigate(999)).toBe('/agents');
  });

  it('queues the path when a window exists but its renderer has not signaled readiness', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { requestNavigate } = await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    const ensureWindow = vi.fn();
    requestNavigate(() => win as unknown as Electron.BrowserWindow, ensureWindow, '/agents');

    // Not ready yet — must not have been delivered over the live channel.
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(ensureWindow).toHaveBeenCalledTimes(1);
  });

  it('queues the path when the window exists but is destroyed', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { requestNavigate, resolvePendingNavigate } = await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    win.isDestroyed = vi.fn(() => true);
    resolvePendingNavigate(win.webContents.id);

    requestNavigate(() => win as unknown as Electron.BrowserWindow, vi.fn(), '/agents');

    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(resolvePendingNavigate(0)).toBe('/agents');
  });

  it('is read-once: a second resolvePendingNavigate call returns null', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { requestNavigate, resolvePendingNavigate } = await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    requestNavigate(() => win as unknown as Electron.BrowserWindow, vi.fn(), '/agents');

    expect(resolvePendingNavigate(win.webContents.id)).toBe('/agents');
    expect(resolvePendingNavigate(win.webContents.id)).toBeNull();
  });

  it('last-write-wins when requestNavigate is called twice before pickup', async () => {
    const { resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { requestNavigate, resolvePendingNavigate } = await import('../navigation');

    requestNavigate(() => null, vi.fn(), '/agents');
    requestNavigate(() => null, vi.fn(), '/tasks');

    expect(resolvePendingNavigate(1)).toBe('/tasks');
  });

  it('marks readiness for the resolving webContents id even with nothing pending', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { requestNavigate, resolvePendingNavigate } = await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    expect(resolvePendingNavigate(win.webContents.id)).toBeNull();

    // Now that this window's renderer is marked ready, a fresh request sends immediately.
    requestNavigate(() => win as unknown as Electron.BrowserWindow, vi.fn(), '/agents');
    expect(win.webContents.send).toHaveBeenCalledWith('navigate', '/agents');
  });
});

describe('registerReadinessReset (renderer reload/crash)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a top-frame navigation (reload) clears readiness: requestNavigate queues instead of sending', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { registerReadinessReset, requestNavigate, resolvePendingNavigate } =
      await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    registerReadinessReset(win as unknown as Electron.BrowserWindow);
    resolvePendingNavigate(win.webContents.id); // renderer subscribed → ready

    // Cmd+R: same webContents.id, but the JS context (and the `navigate`
    // listener with it) is being torn down.
    await win.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });

    requestNavigate(() => win as unknown as Electron.BrowserWindow, vi.fn(), '/agents');
    expect(win.webContents.send).not.toHaveBeenCalled();

    // The remounting hook's pull drains the queued path.
    expect(resolvePendingNavigate(win.webContents.id)).toBe('/agents');
  });

  it('same-document and subframe navigations do not clear readiness (JS context survives)', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { registerReadinessReset, requestNavigate, resolvePendingNavigate } =
      await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    registerReadinessReset(win as unknown as Electron.BrowserWindow);
    resolvePendingNavigate(win.webContents.id);

    await win.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
    });
    await win.webContents.emit('did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false,
    });

    requestNavigate(() => win as unknown as Electron.BrowserWindow, vi.fn(), '/agents');
    expect(win.webContents.send).toHaveBeenCalledWith('navigate', '/agents');
  });

  it('render-process-gone clears readiness: requestNavigate queues instead of sending', async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { registerReadinessReset, requestNavigate, resolvePendingNavigate } =
      await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    registerReadinessReset(win as unknown as Electron.BrowserWindow);
    resolvePendingNavigate(win.webContents.id);

    await win.webContents.emit('render-process-gone');

    requestNavigate(() => win as unknown as Electron.BrowserWindow, vi.fn(), '/agents');
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(resolvePendingNavigate(win.webContents.id)).toBe('/agents');
  });

  it("another window's teardown does not clear a different ready renderer", async () => {
    const { BrowserWindow, resetElectronMock } = await import('./electron-mock');
    resetElectronMock();
    const { registerReadinessReset, requestNavigate, resolvePendingNavigate } =
      await import('../navigation');

    const staleWin = new BrowserWindow({ width: 1200, height: 800 });
    const readyWin = new BrowserWindow({ width: 1200, height: 800 });
    registerReadinessReset(staleWin as unknown as Electron.BrowserWindow);
    resolvePendingNavigate(readyWin.webContents.id);

    await staleWin.webContents.emit('render-process-gone');

    requestNavigate(() => readyWin as unknown as Electron.BrowserWindow, vi.fn(), '/agents');
    expect(readyWin.webContents.send).toHaveBeenCalledWith('navigate', '/agents');
  });
});
