import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => import('../../__tests__/electron-mock'));

import {
  BrowserWindow,
  resetElectronMock,
  type MockBrowserWindow,
} from '../../__tests__/electron-mock';
import { forwardFocusState, FOCUS_CHANGE_CHANNEL } from '../index';

beforeEach(() => {
  resetElectronMock();
});

describe('forwardFocusState (DOR-254)', () => {
  it('pushes true on focus', async () => {
    const win = new BrowserWindow() as unknown as MockBrowserWindow;
    forwardFocusState(win as unknown as Electron.BrowserWindow);

    await win.emit('focus');

    expect(win.webContents.send).toHaveBeenCalledWith(FOCUS_CHANGE_CHANNEL, true);
  });

  it('pushes false on blur', async () => {
    const win = new BrowserWindow() as unknown as MockBrowserWindow;
    forwardFocusState(win as unknown as Electron.BrowserWindow);

    await win.emit('blur');

    expect(win.webContents.send).toHaveBeenCalledWith(FOCUS_CHANGE_CHANNEL, false);
  });

  it('never sends on a destroyed window', async () => {
    const win = new BrowserWindow() as unknown as MockBrowserWindow;
    forwardFocusState(win as unknown as Electron.BrowserWindow);
    win.isDestroyed = vi.fn(() => true);

    await win.emit('blur');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
