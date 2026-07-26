import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));

import { requestCloseTab, resetCloseTab, setupCloseTab } from '../close-tab';
import { BrowserWindow, ipcMain, resetElectronMock, type MockBrowserWindow } from './electron-mock';

/** How long a subscribed renderer gets to answer before the window closes (mirrors ACK_TIMEOUT_MS). */
const ACK_TIMEOUT_MS = 3_000;

beforeEach(() => {
  resetElectronMock();
  resetCloseTab();
  vi.useFakeTimers();
  setupCloseTab();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The listener the module registered for `channel`. */
function listenerFor(channel: string): (event: Electron.IpcMainEvent, ...args: unknown[]) => void {
  const call = vi.mocked(ipcMain.on).mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`no ipcMain.on registered for "${channel}"`);
  return call[1] as (event: Electron.IpcMainEvent, ...args: unknown[]) => void;
}

/** Claim Cmd+W for `win`'s renderer, as the preload does on mount. */
function subscribe(win: MockBrowserWindow): void {
  listenerFor('close-tab:subscribe')({
    sender: win.webContents,
  } as unknown as Electron.IpcMainEvent);
}

/** Give Cmd+W back, as the preload does when its last subscriber unmounts. */
function unsubscribe(win: MockBrowserWindow): void {
  listenerFor('close-tab:unsubscribe')({
    sender: win.webContents,
  } as unknown as Electron.IpcMainEvent);
}

/** Reply to the request the main process just sent `win`. */
function ack(win: MockBrowserWindow, handled: boolean, senderId = win.webContents.id): void {
  const [, requestId] = vi.mocked(win.webContents.send).mock.calls[0];
  listenerFor('close-tab:ack')(
    { sender: { id: senderId } } as unknown as Electron.IpcMainEvent,
    requestId,
    handled
  );
}

/** A window whose renderer has already claimed Cmd+W. */
function makeWindow(): MockBrowserWindow {
  const win = new BrowserWindow({ width: 1200, height: 800 });
  subscribe(win);
  return win;
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
      listenerFor('close-tab:ack')(
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

  it('registers its listeners once', () => {
    setupCloseTab();

    const channels = vi.mocked(ipcMain.on).mock.calls.map(([channel]) => channel);
    expect(channels).toEqual(['close-tab:subscribe', 'close-tab:unsubscribe', 'close-tab:ack']);
  });
});

describe('requestCloseTab — claiming the keystroke', () => {
  it('closes the window with no round trip when nothing claimed Cmd+W', () => {
    // The state of every window today, and of any window whose renderer has
    // not mounted its handler: Cmd+W behaves exactly as it did before tabs.
    const win = new BrowserWindow({ width: 1200, height: 800 });

    requestCloseTab(win as unknown as Electron.BrowserWindow);

    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('stops asking once the renderer gives the keystroke back', () => {
    const win = makeWindow();
    unsubscribe(win);

    requestCloseTab(win as unknown as Electron.BrowserWindow);

    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('asks a subscribed window and leaves an unsubscribed one alone', () => {
    const subscribed = makeWindow();
    const plain = new BrowserWindow({ width: 1200, height: 800 });

    requestCloseTab(subscribed as unknown as Electron.BrowserWindow);
    requestCloseTab(plain as unknown as Electron.BrowserWindow);

    expect(subscribed.webContents.send).toHaveBeenCalledTimes(1);
    expect(subscribed.close).not.toHaveBeenCalled();
    expect(plain.close).toHaveBeenCalledTimes(1);
  });

  it('gives a wedged renderer real time before taking its window', async () => {
    // The budget is a wedged-renderer backstop, not a response budget: a
    // streaming turn blocks the renderer's main thread well past 250ms, and
    // closing a window full of tabs is far worse than a moment's wait.
    const win = makeWindow();
    requestCloseTab(win as unknown as Electron.BrowserWindow);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(win.close).not.toHaveBeenCalled();

    ack(win, true);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    expect(win.close).not.toHaveBeenCalled();
  });
});
