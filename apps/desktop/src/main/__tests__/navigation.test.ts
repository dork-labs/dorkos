import { describe, it, expect, vi, beforeEach } from 'vitest';

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
