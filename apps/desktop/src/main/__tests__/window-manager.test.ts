import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import {
  isMeaningfullyVisible,
  clampSizeToWorkArea,
  validateWindowState,
  createWindow,
  isOwnOrigin,
  type WindowState,
} from '../window-manager';
import { makeDisplay, BrowserWindow, resetElectronMock } from './electron-mock';
import { shell } from 'electron';

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

beforeEach(() => {
  resetElectronMock();
  mockedReadFileSync.mockReset();
  mockedWriteFileSync.mockReset();
});

describe('isMeaningfullyVisible', () => {
  it('is true when the rectangle sits entirely inside the work area', () => {
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };
    expect(isMeaningfullyVisible({ x: 100, y: 100, width: 800, height: 600 }, workArea)).toBe(true);
  });

  it('is false when fewer than 100px overlap on the x axis', () => {
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };
    expect(isMeaningfullyVisible({ x: 1400, y: 100, width: 800, height: 600 }, workArea)).toBe(
      false
    );
  });

  it('is false when fewer than 100px overlap on the y axis', () => {
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };
    expect(isMeaningfullyVisible({ x: 100, y: 850, width: 800, height: 600 }, workArea)).toBe(
      false
    );
  });

  it('is true when exactly 100px overlap in both axes', () => {
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };
    expect(isMeaningfullyVisible({ x: -700, y: -500, width: 800, height: 600 }, workArea)).toBe(
      true
    );
  });
});

describe('clampSizeToWorkArea', () => {
  it('shrinks a size larger than the work area', () => {
    const workArea = { x: 0, y: 0, width: 1024, height: 768 };
    expect(clampSizeToWorkArea({ width: 2000, height: 1500 }, workArea)).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it('leaves a size that already fits unchanged', () => {
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };
    expect(clampSizeToWorkArea({ width: 1200, height: 800 }, workArea)).toEqual({
      width: 1200,
      height: 800,
    });
  });
});

describe('validateWindowState (A2)', () => {
  const primary = makeDisplay({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } });

  it('falls back to a centered default when the saved position is off-screen', () => {
    // Simulates a window restored after its external monitor was unplugged.
    const state: WindowState = { x: 3000, y: 3000, width: 1200, height: 800, isMaximized: false };
    const result = validateWindowState(state, [primary], primary);

    expect(result.width).toBe(1200);
    expect(result.height).toBe(800);
    expect(result.x).toBe(Math.round((1440 - 1200) / 2));
    expect(result.y).toBe(Math.round((900 - 800) / 2));
  });

  it('clamps size to the primary display when discarding an off-screen position', () => {
    const state: WindowState = { x: -5000, y: 0, width: 2000, height: 1500, isMaximized: false };
    const result = validateWindowState(state, [primary], primary);

    expect(result.width).toBe(1440);
    expect(result.height).toBe(900);
  });

  it('keeps a position that is still partially visible', () => {
    // 190px of width still overlaps the primary display's work area — above
    // the 100px visibility threshold, so the saved position is kept as-is.
    const state: WindowState = { x: 1250, y: 100, width: 800, height: 600, isMaximized: false };
    const result = validateWindowState(state, [primary], primary);

    expect(result).toEqual(state);
  });

  it('keeps a position visible on a secondary display', () => {
    const secondary = makeDisplay({
      id: 2,
      workArea: { x: 1440, y: 0, width: 1920, height: 1080 },
    });
    const state: WindowState = { x: 1500, y: 100, width: 800, height: 600, isMaximized: false };
    const result = validateWindowState(state, [primary, secondary], primary);

    expect(result).toEqual(state);
  });

  it('clamps oversized default size when no position was ever saved', () => {
    const state: WindowState = { width: 2000, height: 1200, isMaximized: false };
    const result = validateWindowState(state, [primary], primary);

    expect(result.x).toBeUndefined();
    expect(result.y).toBeUndefined();
    expect(result.width).toBe(1440);
    expect(result.height).toBe(900);
  });
});

describe('createWindow (A2 integration)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-maximizes on launch when the persisted state was maximized', () => {
    const persisted: WindowState = {
      x: 100,
      y: 100,
      width: 1000,
      height: 700,
      isMaximized: true,
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(persisted));

    createWindow();

    const win = BrowserWindow.instances[0];
    expect(win.maximize).toHaveBeenCalledTimes(1);
  });

  it('debounces resize saves — rapid resize events coalesce into a single write', async () => {
    vi.useFakeTimers();
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ x: 100, y: 100, width: 1000, height: 700, isMaximized: false })
    );

    const win = createWindow();

    await win.emit('resize');
    await win.emit('resize');
    await win.emit('resize');

    expect(mockedWriteFileSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it('saves immediately on close, bypassing any pending debounce', async () => {
    vi.useFakeTimers();
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ x: 100, y: 100, width: 1000, height: 700, isMaximized: false })
    );

    const win = createWindow();

    await win.emit('resize');
    await win.emit('close');

    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);

    // The debounced resize save must not fire again after close already saved.
    await vi.advanceTimersByTimeAsync(500);
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('isOwnOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats any file:// URL as the app's own origin (packaged build)", () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '');
    expect(
      isOwnOrigin('file:///Applications/DorkOS.app/Contents/Resources/renderer/index.html')
    ).toBe(true);
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
});

describe('createWindow — external links and navigation guard (P2a)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('setWindowOpenHandler', () => {
    it('opens an http(s) URL in the system browser and denies the in-app window', () => {
      const win = createWindow();
      const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0] as (details: {
        url: string;
      }) => { action: string };

      const result = handler({ url: 'https://example.com/docs' });

      expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
      expect(result).toEqual({ action: 'deny' });
    });

    it('denies a non-http(s) scheme without opening it externally', () => {
      const win = createWindow();
      const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0] as (details: {
        url: string;
      }) => { action: string };

      const result = handler({ url: 'mailto:someone@example.com' });

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({ action: 'deny' });
    });
  });

  describe('will-navigate guard', () => {
    it('blocks navigation to a foreign origin and hands http(s) off to the system browser', async () => {
      vi.stubEnv('ELECTRON_RENDERER_URL', '');
      const win = createWindow();
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
      const win = createWindow();
      const preventDefault = vi.fn();

      await win.webContents.emit('will-navigate', {
        url: 'http://localhost:5173/agents',
        preventDefault,
      });

      expect(preventDefault).not.toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    });
  });
});
