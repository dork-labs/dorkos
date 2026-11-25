import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DORK_DESKTOP_LINK_PREFIX, dorkLinkPath, dorkUriFromLink } from '@dorkos/shared/dork-ref';
import { findDeepLinkArg, parseDeepLink } from '../navigation';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

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
});

describe('parseDeepLink', () => {
  it.each([
    ['dorkos://agents', '/agents'],
    ['dorkos://agents/', '/agents'],
    ['dorkos://agents/123', '/agents/123'],
    ['dorkos://session?id=x', '/session?id=x'],
    ['dorkos://agents?a=1&b=2', '/agents?a=1&b=2'],
    ['dorkos://AGENTS', '/AGENTS'],
    // The way back a finished account connection offers (DOR-2721): the
    // server forwards exactly this link, so it must land on Connections.
    ['dorkos://connections', '/connections'],
    // A `dorkos://r/<dork-uri>` link (DOR-5046) opens the app's `/r/` route,
    // which finds what the reference names and opens it.
    [
      'dorkos://r/dork:chat:7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6',
      '/r/dork:chat:7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6',
    ],
    ['dorkos://r/dork:room:01JD3G5W7X9Y2Z4A6B8C0D1E2F', '/r/dork:room:01JD3G5W7X9Y2Z4A6B8C0D1E2F'],
    ['dorkos://r/dork%3Aentry%3A01JD3H', '/r/dork%3Aentry%3A01JD3H'],
  ])('maps %s to %s', (url, expected) => {
    expect(parseDeepLink(url)).toBe(expected);
  });

  it('hands the /r/ route the same dork: reference the desktop link named', () => {
    const uri = 'dork:agent:01KJ0000000000000000SC7T9Z';
    const path = parseDeepLink(`${DORK_DESKTOP_LINK_PREFIX}${uri}`);
    expect(path).toBe(dorkLinkPath({ kind: 'agent', id: '01KJ0000000000000000SC7T9Z' }));
    expect(dorkUriFromLink(path!)).toBe(uri);
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

  it('expires a queued path older than the server-ready boot budget rather than delivering it stale (DOR-564)', async () => {
    vi.useFakeTimers();
    try {
      const { resetElectronMock } = await import('./electron-mock');
      resetElectronMock();
      const { requestNavigate, resolvePendingNavigate } = await import('../navigation');
      const { SERVER_READY_PARENT_TIMEOUT_MS } = await import('../../shared/boot-timeouts');

      // A dorkos:// deep link arrives with no window/renderer to receive it.
      requestNavigate(() => null, vi.fn(), '/agents');

      vi.advanceTimersByTime(SERVER_READY_PARENT_TIMEOUT_MS + 1);

      // The renderer finally subscribes the next morning — too late.
      expect(resolvePendingNavigate(1)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
});
