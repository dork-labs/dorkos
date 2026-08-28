import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));
// The real one calls the quit guard, stops the server and talks to
// electron-updater. What matters here is that it is asked, and when.
vi.mock('../../auto-updater', () => ({ prepareUpdateRestart: vi.fn(async () => true) }));
// Its own suite covers what it deletes; here the question is what it is asked.
vi.mock('../cache', () => ({ purgeStaleStagedUpdates: vi.fn((): string[] => []) }));
// Real version ordering, spied clearing: the record it clears is the thing
// under test, and faking `isNewerVersion` would fake the whole detection.
vi.mock('../../updater-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../updater-intent')>()),
  clearUpdateIntent: vi.fn(),
}));

import log from 'electron-log';
import { prepareUpdateRestart } from '../../auto-updater';
import { purgeStaleStagedUpdates } from '../cache';
import { clearUpdateIntent } from '../../updater-intent';
import { checkForManualOverwrite, resetManualOverwriteState } from '../manual-overwrite';
import { app, BrowserWindow, dialog, resetElectronMock } from '../../__tests__/electron-mock';
import { resetLogMock } from '../../__tests__/electron-log-mock';

/**
 * Noticing an app replaced on disk while it kept running (DOR-1455, spec
 * decision 8).
 *
 * The bundle is real: these cases write an `Info.plist` into a throwaway
 * `.app` and let the module walk up to it from `app.getPath('exe')`, because
 * "does it read the version off the thing on disk" is the entire behaviour.
 */

const holder = { root: '', bundle: '', exe: '' };

const realPlatform = process.platform;

/** Pretend to be running on `platform` for the duration of a test. */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** Advancing modification time for each install, so cache invalidation is not a race with the clock. */
let installedAt = 0;

/** Give the bundle on disk this `CFBundleShortVersionString`. */
function installOnDisk(version: string): void {
  const plistPath = path.join(holder.bundle, 'Contents', 'Info.plist');
  fs.writeFileSync(
    plistPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '  <key>CFBundleName</key>',
      '  <string>DorkOS</string>',
      '  <key>CFBundleShortVersionString</key>',
      `  <string>${version}</string>`,
      '</dict></plist>',
    ].join('\n')
  );
  installedAt += 60;
  fs.utimesSync(plistPath, installedAt, installedAt);
}

/** Answer the next message box with this button index. */
function answerWith(response: number): void {
  dialog.showMessageBox = vi.fn(() => Promise.resolve({ response, checkboxChecked: false }));
}

/** No window to anchor to — the tray-resident case. */
const noWindow = (): null => null;

beforeEach(() => {
  resetElectronMock();
  resetLogMock();
  resetManualOverwriteState();
  vi.mocked(prepareUpdateRestart).mockClear();
  vi.mocked(prepareUpdateRestart).mockResolvedValue(true);
  vi.mocked(purgeStaleStagedUpdates).mockClear();
  vi.mocked(purgeStaleStagedUpdates).mockReturnValue([]);
  vi.mocked(clearUpdateIntent).mockClear();
  onPlatform('darwin');

  holder.root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-overwrite-'));
  holder.bundle = path.join(holder.root, 'Applications', 'DorkOS.app');
  holder.exe = path.join(holder.bundle, 'Contents', 'MacOS', 'DorkOS');
  fs.mkdirSync(path.dirname(holder.exe), { recursive: true });
  fs.writeFileSync(holder.exe, 'binary');
  installedAt = 1_700_000_000;

  app.isPackaged = true;
  app.getVersion = vi.fn(() => '0.63.0');
  app.getPath = vi.fn((name?: string) =>
    name === 'exe' ? holder.exe : path.join(holder.root, 'userData')
  );
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  fs.rmSync(holder.root, { recursive: true, force: true });
});

describe('checkForManualOverwrite', () => {
  it('offers a restart when the app on disk is newer than the one running', async () => {
    installOnDisk('0.65.0');
    answerWith(0);

    await checkForManualOverwrite(noWindow);

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [
      Electron.MessageBoxOptions,
    ];
    expect(options.message).toBe('DorkOS 0.65.0 was installed. Restart to use it.');
    expect(options.buttons).toEqual(['Restart Now', 'Later']);
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(log.info).mock.calls.some(([line]) => String(line).includes('0.65.0 is installed'))
    ).toBe(true);
  });

  it('asks about mid-run agents BEFORE arming the relaunch', async () => {
    // `app.relaunch()` is a standing instruction for the next exit. Arming it
    // and then being told "Keep Working" leaves the app primed to reopen itself
    // on an unrelated quit hours later.
    installOnDisk('0.65.0');
    answerWith(0);
    const order: string[] = [];
    vi.mocked(prepareUpdateRestart).mockImplementation(async () => {
      order.push('confirm');
      return true;
    });
    vi.mocked(app.relaunch).mockImplementation(() => {
      order.push('relaunch');
    });

    await checkForManualOverwrite(noWindow);

    expect(order).toEqual(['confirm', 'relaunch']);
  });

  it('clears a staged update the installed copy has overtaken, before quitting', async () => {
    // `autoInstallOnAppQuit` applies whatever is staged as this process exits.
    // A leftover older than the copy just installed would land on top of it and
    // undo the very install this restart exists to pick up.
    installOnDisk('0.65.0');
    answerWith(0);
    const order: string[] = [];
    vi.mocked(purgeStaleStagedUpdates).mockImplementation(() => {
      order.push('purge');
      return [];
    });
    vi.mocked(app.quit).mockImplementation(() => {
      order.push('quit');
    });

    await checkForManualOverwrite(noWindow);

    // Judged against the version about to run, not the one running now.
    expect(purgeStaleStagedUpdates).toHaveBeenCalledWith('0.65.0');
    expect(order).toEqual(['purge', 'quit']);
  });

  it('forgets the install attempt when the purge deleted the update it named', async () => {
    // `prepareUpdateRestart` records an attempt for whatever is staged. If the
    // purge then deletes exactly that, nothing will install it — and the next
    // launch would count a failure against an install nobody attempted. Two of
    // those stop offering a plain restart at all.
    installOnDisk('0.65.0');
    answerWith(0);
    vi.mocked(purgeStaleStagedUpdates).mockReturnValue(['/Caches/@dorkosdesktop-updater/pending']);

    await checkForManualOverwrite(noWindow);

    expect(clearUpdateIntent).toHaveBeenCalledTimes(1);
  });

  it('keeps the install attempt on record when the purge deleted nothing', async () => {
    // Nothing was deleted, so whatever is staged is newer than the copy just
    // installed and Squirrel may still apply it on the way out. That attempt is
    // real and has to stay counted.
    installOnDisk('0.65.0');
    answerWith(0);
    vi.mocked(purgeStaleStagedUpdates).mockReturnValue([]);

    await checkForManualOverwrite(noWindow);

    expect(clearUpdateIntent).not.toHaveBeenCalled();
  });

  it('arms nothing when the person keeps their agents working', async () => {
    installOnDisk('0.65.0');
    answerWith(0);
    vi.mocked(prepareUpdateRestart).mockResolvedValue(false);

    await checkForManualOverwrite(noWindow);

    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('does nothing on "Later"', async () => {
    installOnDisk('0.65.0');
    answerWith(1);

    await checkForManualOverwrite(noWindow);

    expect(prepareUpdateRestart).not.toHaveBeenCalled();
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('says nothing when the app on disk is the one already running', async () => {
    installOnDisk('0.63.0');

    await checkForManualOverwrite(noWindow);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('says nothing when the app on disk is older than the one running', async () => {
    // Someone dragged an old copy back in, or restored from a backup. Their
    // running app is fine; interrupting them to offer a downgrade is not.
    installOnDisk('0.60.0');

    await checkForManualOverwrite(noWindow);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('asks once per version, however many times the window is focused', async () => {
    installOnDisk('0.65.0');
    answerWith(1);

    await checkForManualOverwrite(noWindow);
    await checkForManualOverwrite(noWindow);
    await checkForManualOverwrite(noWindow);

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('asks again when a further version lands', async () => {
    installOnDisk('0.65.0');
    answerWith(1);
    await checkForManualOverwrite(noWindow);

    installOnDisk('0.66.0');
    await checkForManualOverwrite(noWindow);

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    const [second] = vi.mocked(dialog.showMessageBox).mock.calls[1] as [Electron.MessageBoxOptions];
    expect(second.message).toContain('0.66.0');
  });

  it('does not re-read the bundle when nothing on disk has changed', async () => {
    // Called on every window focus, which a person switching apps produces a lot
    // of. Same file, same modification time — the answer is reused, so a plist
    // rewritten in place without touching its timestamp is deliberately not
    // noticed here.
    installOnDisk('0.65.0');
    answerWith(1);
    await checkForManualOverwrite(noWindow);

    const plistPath = path.join(holder.bundle, 'Contents', 'Info.plist');
    const { atime, mtime } = fs.statSync(plistPath);
    installOnDisk('0.70.0');
    fs.utimesSync(plistPath, atime, mtime);

    await checkForManualOverwrite(noWindow);

    // One prompt, for 0.65.0: the second read never happened.
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('never fires in development, where the bundle is Electron itself', async () => {
    // A dev build runs from Electron's own `.app`, whose plist names Electron's
    // version — a number far above any DorkOS release. Ungated, this would
    // prompt on every window focus in development.
    installOnDisk('38.1.0');
    app.isPackaged = false;

    await checkForManualOverwrite(noWindow);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('says nothing off macOS, where there is no bundle to read', async () => {
    installOnDisk('0.65.0');
    onPlatform('win32');

    await checkForManualOverwrite(noWindow);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('says nothing when the plist cannot be read', async () => {
    // A binary plist, a truncated file, a bundle mid-copy. Guessing here means
    // interrupting someone over a version we did not actually read.
    fs.writeFileSync(path.join(holder.bundle, 'Contents', 'Info.plist'), 'bplist00 ');

    await checkForManualOverwrite(noWindow);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('anchors the offer to the window when there is one', async () => {
    installOnDisk('0.65.0');
    answerWith(1);
    const win = new BrowserWindow({ width: 1200, height: 800 });

    await checkForManualOverwrite(() => win as unknown as Electron.BrowserWindow);

    const [first] = vi.mocked(dialog.showMessageBox).mock.calls[0];
    expect(first).toBe(win);
  });
});
