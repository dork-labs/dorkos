/**
 * The "DorkOS stopped" page and its one button (DOR-3229): only that page may
 * ask for a restart, the page carries the real try count, and the system
 * notification is sent once at most.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

import {
  BrowserWindow,
  ipcMain,
  Notification,
  resetElectronMock,
} from '../../__tests__/electron-mock';
import { STOPPED_PAGE_FILE } from '../../../shared/stopped-page';
import {
  isStoppedPageUrl,
  registerServerStoppedIpc,
  resetServerStoppedForTests,
  RESTART_AFTER_STOP_CHANNEL,
  setServerRestarting,
  showServerStopped,
} from '../index';

/** Where the module resolves the page, beside the compiled main process. */
const STOPPED_PAGE_URL = pathToFileURL(join(__dirname, '..', STOPPED_PAGE_FILE)).href;

/** The handler registered for the restart channel. */
function restartHandler(): (event: { sender: { getURL: () => string } }) => Promise<void> {
  const call = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === RESTART_AFTER_STOP_CHANNEL);
  if (!call) throw new Error('no restart handler registered');
  return call[1] as (event: { sender: { getURL: () => string } }) => Promise<void>;
}

beforeEach(() => {
  resetElectronMock();
  resetServerStoppedForTests();
});

describe('isStoppedPageUrl', () => {
  it('knows its own page, with or without the try count', () => {
    expect(isStoppedPageUrl(STOPPED_PAGE_URL)).toBe(true);
    expect(isStoppedPageUrl(`${STOPPED_PAGE_URL}?tries=4`)).toBe(true);
  });

  it.each([
    ['the app', 'http://localhost:4242/'],
    ['another file', pathToFileURL('/tmp/server-stopped.html').href],
    ['nothing', ''],
  ])('refuses %s', (_name, url) => {
    expect(isStoppedPageUrl(url)).toBe(false);
  });
});

describe('Restart DorkOS', () => {
  it('runs only for the stopped page, never for the app', async () => {
    const restart = vi.fn(async () => undefined);
    registerServerStoppedIpc();
    showServerStopped(4, restart);

    // The app runs third-party extension code, so it may not ask.
    await restartHandler()({ sender: { getURL: () => 'http://localhost:4242/' } });
    expect(restart).not.toHaveBeenCalled();

    await restartHandler()({ sender: { getURL: () => `${STOPPED_PAGE_URL}?tries=4` } });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('runs once while a restart is already under way', async () => {
    let finish: () => void = () => undefined;
    const restart = vi.fn(() => new Promise<void>((done) => (finish = done)));
    registerServerStoppedIpc();
    showServerStopped(4, restart);
    const page = { sender: { getURL: () => STOPPED_PAGE_URL } };

    const first = restartHandler()(page);
    const second = restartHandler()(page);
    finish();
    await Promise.all([first, second]);

    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('showServerStopped', () => {
  it('shows the page with the real try count in every window', () => {
    const one = new BrowserWindow();
    const two = new BrowserWindow();
    showServerStopped(3, async () => undefined);

    for (const win of [one, two]) {
      expect(win.loadFile).toHaveBeenCalledWith(expect.stringMatching(/server-stopped\.html$/), {
        query: { tries: '3' },
      });
    }
  });

  it('sends no notification when a DorkOS window is in front', () => {
    const win = new BrowserWindow();
    BrowserWindow.getFocusedWindow = vi.fn(() => win);
    showServerStopped(4, async () => undefined);

    expect(Notification.instances).toHaveLength(0);
  });

  it('sends one notification when none is, and never repeats it', async () => {
    new BrowserWindow();
    BrowserWindow.getFocusedWindow = vi.fn(() => null);
    const restart = vi.fn(async () => undefined);
    showServerStopped(4, restart);
    showServerStopped(4, restart);

    expect(Notification.instances).toHaveLength(1);
    expect(Notification.instances[0]?.options).toMatchObject({
      title: 'DorkOS stopped',
      body: 'Click to restart',
    });
    await Notification.instances[0]?.emitClick();
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('setServerRestarting', () => {
  it('tells every window', () => {
    const one = new BrowserWindow();
    const two = new BrowserWindow();
    setServerRestarting(true);

    for (const win of [one, two]) {
      expect(win.webContents.send).toHaveBeenCalledWith('server:restarting', true);
    }
  });
});
