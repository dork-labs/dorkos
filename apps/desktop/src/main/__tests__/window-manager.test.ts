import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { createWindow, isOwnOrigin, makeRendererUrlAccessor } from '../window-manager';
import { resetWindowStateModule } from '../window-state';
import {
  app,
  BrowserWindow,
  resetElectronMock,
  nativeTheme,
  type MockBrowserWindow,
} from './electron-mock';
import { shell } from 'electron';

const mockedReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  resetElectronMock();
  resetWindowStateModule();
  mockedReadFileSync.mockReset();
  vi.mocked(writeFileSync).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The window-open handler `createWindow` installed on `win`. */
function windowOpenHandler(
  win: MockBrowserWindow
): (details: Pick<HandlerDetails, 'url'>) => WindowOpenHandlerResponse {
  const handler = vi.mocked(win.webContents.setWindowOpenHandler).mock.calls[0][0];
  return handler as (details: Pick<HandlerDetails, 'url'>) => WindowOpenHandlerResponse;
}

/** A live accessor returning a fixed origin, as `index.ts` supplies. */
function origin(url: string | undefined): () => string | undefined {
  return () => url;
}

describe('createWindow — first paint (M5)', () => {
  it('creates the window hidden with a background colour, and shows it on ready-to-show', async () => {
    const win = createWindow() as unknown as MockBrowserWindow;

    expect(win.options.show).toBe(false);
    expect(win.options.backgroundColor).toBe('#0a0a0a');
    expect(win.show).not.toHaveBeenCalled();

    await win.emit('ready-to-show');

    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('uses the light background when the OS is in light mode', () => {
    nativeTheme.shouldUseDarkColors = false;

    const win = createWindow() as unknown as MockBrowserWindow;

    expect(win.options.backgroundColor).toBe('#fafafa');
  });

  it('re-maximizes on show when the persisted state was maximized', async () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ x: 100, y: 100, width: 1000, height: 700, isMaximized: true })
    );

    const win = createWindow() as unknown as MockBrowserWindow;
    // Maximizing before the window is shown opens it un-maximized on macOS.
    expect(win.maximize).not.toHaveBeenCalled();

    await win.emit('ready-to-show');

    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('shows the window anyway if the renderer never paints', async () => {
    vi.useFakeTimers();
    const win = createWindow() as unknown as MockBrowserWindow;

    await vi.advanceTimersByTimeAsync(4_000);

    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('never shows twice when the fallback and ready-to-show both fire', async () => {
    vi.useFakeTimers();
    const win = createWindow() as unknown as MockBrowserWindow;

    await win.emit('ready-to-show');
    await vi.advanceTimersByTimeAsync(4_000);

    expect(win.show).toHaveBeenCalledTimes(1);
  });
});

describe('createWindow — renderer loading', () => {
  it('loads the built renderer via file:// when no dev server or rendererUrl is available (electron-vite preview)', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');

    const win = createWindow() as unknown as MockBrowserWindow;

    expect(win.loadFile).toHaveBeenCalledTimes(1);
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it("loads via the bundled server's localhost origin in a packaged build (rendererUrl passed, no dev server)", () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');

    const win = createWindow({
      getRendererUrl: origin('http://localhost:54321'),
    }) as unknown as MockBrowserWindow;

    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:54321');
    expect(win.loadFile).not.toHaveBeenCalled();
  });

  it('prefers the dev server URL over rendererUrl when both are present', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');

    const win = createWindow({
      getRendererUrl: origin('http://localhost:54321'),
    }) as unknown as MockBrowserWindow;

    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173');
  });
});

describe('isOwnOrigin', () => {
  // The module under test resolves its renderer bundle relative to its own
  // location (`resolve(__dirname, '../renderer')` — same layout as loadFile),
  // so these tests build file:// URLs against that same directory.
  const rendererDir = join(__dirname, '../../renderer');

  it("treats the app's own renderer index.html as own origin (packaged build)", () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    expect(isOwnOrigin(pathToFileURL(join(rendererDir, 'index.html')).href)).toBe(true);
  });

  it('treats renderer bundle assets (subdirectories) as own origin', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    expect(isOwnOrigin(pathToFileURL(join(rendererDir, 'assets/index-abc123.js')).href)).toBe(true);
  });

  it('rejects a file:// URL outside the renderer bundle (packaged build)', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    expect(isOwnOrigin('file:///etc/passwd')).toBe(false);
  });

  it('rejects a sibling directory that shares the renderer path as a string prefix', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    expect(isOwnOrigin(pathToFileURL(`${rendererDir}-evil/index.html`).href)).toBe(false);
  });

  it("treats the dev server origin as the app's own origin", () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    expect(isOwnOrigin('http://localhost:5173/session?id=42')).toBe(true);
  });

  it('rejects a foreign http(s) origin even when a dev server URL is set', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    expect(isOwnOrigin('https://example.com')).toBe(false);
  });

  it('rejects a foreign origin when no dev server URL is set (packaged build)', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    expect(isOwnOrigin('https://example.com')).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isOwnOrigin('not a url')).toBe(false);
  });

  it("treats the bundled server's localhost origin as own origin when passed explicitly (packaged build)", () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    expect(isOwnOrigin('http://localhost:54321/agents', 'http://localhost:54321')).toBe(true);
  });

  it('rejects a foreign origin even when a rendererUrl is passed', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    expect(isOwnOrigin('https://example.com', 'http://localhost:54321')).toBe(false);
  });

  it('prefers ELECTRON_RENDERER_URL over rendererUrl when both are present', () => {
    // Dev never passes rendererUrl in practice (see createWindow), but the
    // precedence matters if it ever did: HMR's dev-server origin is the
    // real own-origin, not the packaged-build fallback.
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    expect(isOwnOrigin('http://localhost:5173/agents', 'http://localhost:54321')).toBe(true);
    expect(isOwnOrigin('http://localhost:54321/agents', 'http://localhost:54321')).toBe(false);
  });
});

describe('createWindow — window.open (C2)', () => {
  it("opens the app's own origin as a second cockpit window, not in the system browser", () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    const opener = createWindow({
      getRendererUrl: origin('http://localhost:54321'),
    }) as unknown as MockBrowserWindow;

    const result = windowOpenHandler(opener)({ url: 'http://localhost:54321/session?id=42' });

    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'deny' });
    // Electron's own `allow` path would produce a popup shaped by the page's
    // `features` string; the second window is built here instead.
    expect(BrowserWindow.instances).toHaveLength(2);
    const second = BrowserWindow.instances[1];
    expect(second.loadURL).toHaveBeenCalledWith('http://localhost:54321/session?id=42');
  });

  it('gives the second window the same locked-down webPreferences as the first', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    const opener = createWindow({
      getRendererUrl: origin('http://localhost:54321'),
    }) as unknown as MockBrowserWindow;

    windowOpenHandler(opener)({ url: 'http://localhost:54321/agents' });

    const second = BrowserWindow.instances[1];
    expect(second.options.webPreferences).toEqual(opener.options.webPreferences);
    expect(second.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect((second.options.webPreferences as { preload: string }).preload).toContain('preload');
  });

  it('guards the second window the same way, so it can open a third and still refuse foreign links', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    const opener = createWindow({
      getRendererUrl: origin('http://localhost:54321'),
    }) as unknown as MockBrowserWindow;
    windowOpenHandler(opener)({ url: 'http://localhost:54321/agents' });

    const second = BrowserWindow.instances[1];
    expect(windowOpenHandler(second)({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('only the first window persists its geometry — two writers would race one file', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ x: 100, y: 100, width: 1000, height: 700, isMaximized: false })
    );
    const opener = createWindow({
      getRendererUrl: origin('http://localhost:54321'),
    }) as unknown as MockBrowserWindow;
    windowOpenHandler(opener)({ url: 'http://localhost:54321/agents' });

    const second = BrowserWindow.instances[1];
    await second.emit('close');
    await vi.advanceTimersByTimeAsync(500);

    expect(writeFileSync).not.toHaveBeenCalled();

    await opener.emit('close');
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('opens an http(s) URL in the system browser and denies the in-app window', () => {
    const win = createWindow() as unknown as MockBrowserWindow;

    const result = windowOpenHandler(win)({ url: 'https://example.com/docs' });

    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(result).toEqual({ action: 'deny' });
    expect(BrowserWindow.instances).toHaveLength(1);
  });

  it('denies a non-http(s) scheme without opening it externally', () => {
    const win = createWindow() as unknown as MockBrowserWindow;

    const result = windowOpenHandler(win)({ url: 'mailto:someone@example.com' });

    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'deny' });
  });
});

describe('createWindow — will-navigate guard', () => {
  it('blocks navigation to a foreign origin and hands http(s) off to the system browser', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    const win = createWindow() as unknown as MockBrowserWindow;
    const preventDefault = vi.fn();

    await win.webContents.emit('will-navigate', {
      url: 'https://example.com/evil',
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/evil');
  });

  it("allows navigation to the app's own origin", async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    const win = createWindow() as unknown as MockBrowserWindow;
    const preventDefault = vi.fn();

    await win.webContents.emit('will-navigate', {
      url: 'http://localhost:5173/agents',
      preventDefault,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("allows navigation to the bundled server's localhost origin in a packaged build", async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    const win = createWindow({
      getRendererUrl: origin('http://localhost:54321'),
    }) as unknown as MockBrowserWindow;
    const preventDefault = vi.fn();

    await win.webContents.emit('will-navigate', {
      url: 'http://localhost:54321/agents',
      preventDefault,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('still blocks a foreign origin in a packaged build (rendererUrl set)', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    const win = createWindow({
      getRendererUrl: origin('http://localhost:54321'),
    }) as unknown as MockBrowserWindow;
    const preventDefault = vi.fn();

    await win.webContents.emit('will-navigate', {
      url: 'https://example.com/evil',
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/evil');
  });

  it('follows the server to a new port after a restart, instead of externalising our own pages (H4)', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    let port = 54321;
    const win = createWindow({
      getRendererUrl: () => `http://localhost:${port}`,
    }) as unknown as MockBrowserWindow;

    // The server crashed and came back on a different port.
    port = 54999;
    const preventDefault = vi.fn();
    await win.webContents.emit('will-navigate', {
      url: 'http://localhost:54999/agents',
      preventDefault,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('makeRendererUrlAccessor', () => {
  it('is undefined in dev, where electron-vite serves the renderer', () => {
    app.isPackaged = false;
    expect(makeRendererUrlAccessor(() => 4242)()).toBeUndefined();
  });

  it('is undefined while no server is running', () => {
    app.isPackaged = true;
    expect(makeRendererUrlAccessor(() => null)()).toBeUndefined();
  });

  it("is the server's own origin in a packaged build, re-read every call", () => {
    app.isPackaged = true;
    let port: number | null = 4242;
    const accessor = makeRendererUrlAccessor(() => port);

    expect(accessor()).toBe('http://localhost:4242');
    port = 5555;
    expect(accessor()).toBe('http://localhost:5555');
  });

  it('keeps answering with the last origin it served while the port is gone (DOR-542)', () => {
    // The window is still sitting on that origin through every gap — a crash, a
    // restart in flight, a restart that failed. Answering `undefined` there tells
    // the link guards, the permission policy and the admin channels that our own
    // cockpit is a foreign document, which is how Restart came back with "DorkOS
    // only takes this from its own window" at the one moment somebody needs it.
    app.isPackaged = true;
    let port: number | null = 4242;
    const accessor = makeRendererUrlAccessor(() => port);
    expect(accessor()).toBe('http://localhost:4242');

    port = null;

    expect(accessor()).toBe('http://localhost:4242');
  });

  it('prefers a live port over the one it remembered', () => {
    app.isPackaged = true;
    let port: number | null = 4242;
    const accessor = makeRendererUrlAccessor(() => port);
    accessor();

    port = null;
    expect(accessor()).toBe('http://localhost:4242');
    port = 4243;

    // A restart that moved the port must move the guards with it; the memory is
    // only ever a stand-in for a port that is missing.
    expect(accessor()).toBe('http://localhost:4243');
  });
});
