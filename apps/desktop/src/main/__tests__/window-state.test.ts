import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import {
  attachWindowStatePersistence,
  clampSizeToWorkArea,
  isMeaningfullyVisible,
  loadValidatedWindowState,
  resetWindowStateModule,
  shapeWindowState,
  validateWindowState,
  watchDisplayChanges,
  type WindowState,
} from '../window-state';
import {
  makeDisplay,
  BrowserWindow,
  resetElectronMock,
  type MockBrowserWindow,
} from './electron-mock';
import { screen } from 'electron';

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

beforeEach(() => {
  resetElectronMock();
  resetWindowStateModule();
  mockedReadFileSync.mockReset();
  mockedWriteFileSync.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Build a mock window with sensible restored bounds. */
function makeWindow(bounds: Partial<WindowState> = {}): MockBrowserWindow {
  return new BrowserWindow({ x: 100, y: 100, width: 1000, height: 700, ...bounds });
}

describe('isMeaningfullyVisible', () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };

  it('is true when the rectangle sits entirely inside the work area', () => {
    expect(isMeaningfullyVisible({ x: 100, y: 100, width: 800, height: 600 }, workArea)).toBe(true);
  });

  it('is false when fewer than 100px overlap on the x axis', () => {
    expect(isMeaningfullyVisible({ x: 1400, y: 100, width: 800, height: 600 }, workArea)).toBe(
      false
    );
  });

  it('is false when fewer than 100px overlap on the y axis', () => {
    expect(isMeaningfullyVisible({ x: 100, y: 850, width: 800, height: 600 }, workArea)).toBe(
      false
    );
  });

  it('is true when exactly 100px overlap in both axes', () => {
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

describe('validateWindowState', () => {
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

  it('clamps an oversized size even when the position is still visible (H6)', () => {
    // The full-screen case: bounds cover the whole display including the
    // menu-bar strip, so the window is "visible" by every measure yet comes
    // back jammed under the menu bar unless the size is clamped here too.
    const display = makeDisplay({
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
    });
    const state: WindowState = { x: 0, y: 0, width: 1440, height: 900, isMaximized: false };

    const result = validateWindowState(state, [display], display);

    expect(result.width).toBe(1440);
    expect(result.height).toBe(875);
  });
});

describe('shapeWindowState', () => {
  const previous: WindowState = { x: 10, y: 20, width: 900, height: 600, isMaximized: false };

  it('captures the current bounds of a restored window', () => {
    const win = makeWindow({ x: 5, y: 6, width: 800, height: 700 });

    expect(shapeWindowState(win as never, previous)).toEqual({
      x: 5,
      y: 6,
      width: 800,
      height: 700,
      isMaximized: false,
    });
  });

  it('keeps the previously saved restored bounds while maximized', () => {
    const win = makeWindow();
    win.maximize();

    expect(shapeWindowState(win as never, previous)).toEqual({ ...previous, isMaximized: true });
  });

  it('keeps the previously saved restored bounds while full-screen (H6)', () => {
    // isMaximized() reports false in full screen while getBounds() returns the
    // whole display — capturing those bounds is what stranded the window under
    // the menu bar on the next launch.
    const win = makeWindow({ x: 0, y: 0, width: 1440, height: 900 });
    win.setFullScreen(true);

    expect(shapeWindowState(win as never, previous)).toEqual({ ...previous, isMaximized: true });
  });
});

describe('attachWindowStatePersistence', () => {
  beforeEach(() => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ x: 100, y: 100, width: 1000, height: 700, isMaximized: false })
    );
  });

  it('debounces resize saves — rapid resize events coalesce into a single write', async () => {
    vi.useFakeTimers();
    const win = makeWindow();
    attachWindowStatePersistence(win as never);

    await win.emit('resize');
    await win.emit('resize');
    await win.emit('resize');

    expect(mockedWriteFileSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it('saves immediately on close, bypassing any pending debounce', async () => {
    vi.useFakeTimers();
    const win = makeWindow();
    attachWindowStatePersistence(win as never);

    await win.emit('resize');
    await win.emit('close');

    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);

    // The debounced resize save must not fire again after close already saved.
    await vi.advanceTimersByTimeAsync(500);
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it('reads the state file once, not on every save (M6)', async () => {
    vi.useFakeTimers();
    const win = makeWindow();
    attachWindowStatePersistence(win as never);

    await win.emit('resize');
    await vi.advanceTimersByTimeAsync(500);
    await win.emit('move');
    await vi.advanceTimersByTimeAsync(500);
    await win.emit('close');

    expect(mockedWriteFileSync).toHaveBeenCalledTimes(3);
    expect(mockedReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('survives a write failure rather than throwing out of the close handler', async () => {
    const win = makeWindow();
    attachWindowStatePersistence(win as never);
    mockedWriteFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(win.emit('close')).resolves.toBeUndefined();
  });
});

describe('loadValidatedWindowState', () => {
  it('returns defaults when there is no saved state', () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(loadValidatedWindowState()).toEqual({ width: 1200, height: 800, isMaximized: false });
  });
});

describe('watchDisplayChanges (M6)', () => {
  it('moves a window back on screen when a display is removed', async () => {
    const primary = makeDisplay({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } });
    vi.mocked(screen.getAllDisplays).mockReturnValue([primary]);
    vi.mocked(screen.getPrimaryDisplay).mockReturnValue(primary);

    const stranded = makeWindow({ x: 3000, y: 3000, width: 800, height: 600 });
    watchDisplayChanges(() => [stranded as never]);

    await screen.emit('display-removed');

    expect(stranded.setBounds).toHaveBeenCalledWith({
      x: Math.round((1440 - 800) / 2),
      y: Math.round((900 - 600) / 2),
      width: 800,
      height: 600,
    });
  });

  it('leaves a window that is still on screen alone', async () => {
    const onScreen = makeWindow({ x: 100, y: 100, width: 800, height: 600 });
    watchDisplayChanges(() => [onScreen as never]);

    await screen.emit('display-metrics-changed');

    expect(onScreen.setBounds).not.toHaveBeenCalled();
  });

  it('skips a maximized or full-screen window — the OS re-lays those out itself', async () => {
    const maximized = makeWindow({ x: 3000, y: 3000, width: 800, height: 600 });
    maximized.maximize();
    const fullScreen = makeWindow({ x: 3000, y: 3000, width: 800, height: 600 });
    fullScreen.setFullScreen(true);
    watchDisplayChanges(() => [maximized as never, fullScreen as never]);

    await screen.emit('display-removed');

    expect(maximized.setBounds).not.toHaveBeenCalled();
    expect(fullScreen.setBounds).not.toHaveBeenCalled();
  });

  it('does not stack listeners across repeated calls', () => {
    watchDisplayChanges(() => []);
    watchDisplayChanges(() => []);

    const registered = vi.mocked(screen.on).mock.calls.map(([event]) => event);
    expect(registered).toEqual(['display-removed', 'display-metrics-changed']);
  });
});
