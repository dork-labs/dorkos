import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { announceBackgroundRunning, NOTICE_FILE_PATH } from '../background-notice';
import { app, dialog, resetElectronMock } from './electron-mock';

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const originalPlatform = process.platform;

/** Pretend the notice ledger holds `contents`, or is missing when `null`. */
function ledger(contents: Record<string, boolean> | null): void {
  if (contents === null) {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    return;
  }
  mockedReadFileSync.mockReturnValue(JSON.stringify(contents));
}

beforeEach(() => {
  resetElectronMock();
  mockedReadFileSync.mockReset();
  mockedWriteFileSync.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('announceBackgroundRunning', () => {
  it('says DorkOS is still running, and where to find it', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    ledger(null);

    await announceBackgroundRunning();

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [
      Electron.MessageBoxOptions,
    ];
    expect(options.message).toBe('DorkOS is still running, so your agents keep working.');
    expect(options.detail).toContain('menu bar');
    expect(options.buttons).toEqual(['Got It', 'Quit DorkOS']);
  });

  it('points at the notification area on Windows, not the menu bar', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    ledger(null);

    await announceBackgroundRunning();

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [
      Electron.MessageBoxOptions,
    ];
    expect(options.detail).toContain('notification area');
  });

  it('shows once, then never again', async () => {
    ledger(null);
    await announceBackgroundRunning();
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      NOTICE_FILE_PATH,
      JSON.stringify({ backgroundRunning: true })
    );

    ledger({ backgroundRunning: true });
    await announceBackgroundRunning();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('quits when that is what the person meant all along', async () => {
    ledger(null);
    dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));

    await announceBackgroundRunning();

    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('does not quit on the reassuring answer', async () => {
    ledger(null);

    await announceBackgroundRunning();

    expect(app.quit).not.toHaveBeenCalled();
  });

  it('still shows the notice when the ledger cannot be written', async () => {
    ledger(null);
    mockedWriteFileSync.mockImplementation(() => {
      throw new Error('read-only volume');
    });

    await expect(announceBackgroundRunning()).resolves.toBeUndefined();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
