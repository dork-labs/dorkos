import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDeepLink } from '../navigation';

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
