import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));

import { requestCloseTab, resetCloseTab, setupCloseTab } from '../close-tab';
import { BrowserWindow, ipcMain, resetElectronMock, type MockBrowserWindow } from './electron-mock';

/** How long the renderer gets to answer before the window closes (mirrors ACK_TIMEOUT_MS). */
const ACK_TIMEOUT_MS = 250;

beforeEach(() => {
  resetElectronMock();
  resetCloseTab();
  vi.useFakeTimers();
  setupCloseTab();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The `close-tab:ack` listener the module registered. */
function ackListener(): (event: Electron.IpcMainEvent, ...args: unknown[]) => void {
  const call = vi.mocked(ipcMain.on).mock.calls.find(([channel]) => channel === 'close-tab:ack');
  if (!call) throw new Error('no ipcMain.on registered for "close-tab:ack"');
  return call[1] as (event: Electron.IpcMainEvent, ...args: unknown[]) => void;
}

/** Reply to the request the main process just sent `win`. */
function ack(win: MockBrowserWindow, handled: boolean, senderId = win.webContents.id): void {
  const [, requestId] = vi.mocked(win.webContents.send).mock.calls[0];
  ackListener()(
    { sender: { id: senderId } } as unknown as Electron.IpcMainEvent,
    requestId,
    handled
  );
}

function makeWindow(): MockBrowserWindow {
  return new BrowserWindow({ width: 1200, height: 800 });
}

describe('requestCloseTab', () => {
  it('asks the focused renderer to close a tab', () => {
    const win = makeWindow();

    requestCloseTab(win as unknown as Electron.BrowserWindow);

    expect(win.webContents.send).toHaveBeenCalledWith('close-tab', expect.any(Number));
    expect(win.close).not.toHaveBeenCalled();
  });

  it('leaves the window open when the renderer says it closed a tab', async () => {
    const win = makeWindow();
    requestCloseTab(win as unknown as Electron.BrowserWindow);

    ack(win, true);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 4);

    expect(win.close).not.toHaveBeenCalled();
  });

  it('closes the window when the renderer has no tab left to close', () => {
    const win = makeWindow();
    requestCloseTab(win as unknown as Electron.BrowserWindow);

    ack(win, false);

    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('closes the window when nothing answers — Cmd+W must never do nothing', async () => {
    const win = makeWindow();
    requestCloseTab(win as unknown as Electron.BrowserWindow);

    expect(win.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);

    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('ignores a late answer, so a slow renderer cannot close the window twice', async () => {
    const win = makeWindow();
    requestCloseTab(win as unknown as Electron.BrowserWindow);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);

    ack(win, false);

    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('ignores an answer from a renderer that was not asked', async () => {
    const win = makeWindow();
    const stranger = makeWindow();
    requestCloseTab(win as unknown as Electron.BrowserWindow);

    ack(win, true, stranger.webContents.id);

    // The stray "I handled it" is discarded, so the timeout still closes it.
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed answer', () => {
    const win = makeWindow();
    requestCloseTab(win as unknown as Electron.BrowserWindow);

    expect(() =>
      ackListener()(
        { sender: { id: 1 } } as unknown as Electron.IpcMainEvent,
        'not-a-number',
        false
      )
    ).not.toThrow();
    expect(win.close).not.toHaveBeenCalled();
  });

  it('tracks each window separately when two are asked at once', () => {
    const first = makeWindow();
    const second = makeWindow();

    requestCloseTab(first as unknown as Electron.BrowserWindow);
    requestCloseTab(second as unknown as Electron.BrowserWindow);
    ack(first, true);
    ack(second, false);

    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no window is focused', () => {
    expect(() => requestCloseTab(null)).not.toThrow();
  });

  it('does not close a window that was destroyed while its renderer was thinking', async () => {
    const win = makeWindow();
    requestCloseTab(win as unknown as Electron.BrowserWindow);
    win.isDestroyed = vi.fn(() => true);

    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);

    expect(win.close).not.toHaveBeenCalled();
  });

  it('registers its listener once', () => {
    setupCloseTab();

    const registrations = vi
      .mocked(ipcMain.on)
      .mock.calls.filter(([channel]) => channel === 'close-tab:ack');
    expect(registrations).toHaveLength(1);
  });
});
