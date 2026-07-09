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
  type WindowState,
} from '../window-manager';
import { makeDisplay, BrowserWindow, resetElectronMock } from './electron-mock';

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
