import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => import('../../__tests__/electron-mock'));

import {
  BrowserWindow,
  resetElectronMock,
  type MockBrowserWindow,
} from '../../__tests__/electron-mock';
import { forwardFullscreenState, FULLSCREEN_CHANGE_CHANNEL } from '../index';

beforeEach(() => {
  resetElectronMock();
});

describe('forwardFullscreenState (DOR-563)', () => {
  it('pushes true on enter-full-screen', async () => {
    const win = new BrowserWindow() as unknown as MockBrowserWindow;
    forwardFullscreenState(win as unknown as Electron.BrowserWindow);

    await win.emit('enter-full-screen');

    expect(win.webContents.send).toHaveBeenCalledWith(FULLSCREEN_CHANGE_CHANNEL, true);
  });

  it('pushes false on leave-full-screen', async () => {
    const win = new BrowserWindow() as unknown as MockBrowserWindow;
    forwardFullscreenState(win as unknown as Electron.BrowserWindow);

    await win.emit('leave-full-screen');

    expect(win.webContents.send).toHaveBeenCalledWith(FULLSCREEN_CHANGE_CHANNEL, false);
  });

  it('never sends on a destroyed window', async () => {
    const win = new BrowserWindow() as unknown as MockBrowserWindow;
    forwardFullscreenState(win as unknown as Electron.BrowserWindow);
    win.isDestroyed = vi.fn(() => true);

    await win.emit('enter-full-screen');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
