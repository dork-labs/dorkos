import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));
const quitting = vi.hoisted(() => ({ value: false }));
vi.mock('../../quit-guard', () => ({ isQuitting: () => quitting.value }));

import { app, ipcMain } from 'electron';
import {
  BrowserWindow,
  mockUserDataPath,
  resetElectronMock,
  type MockBrowserWindow,
} from '../../__tests__/electron-mock';
import {
  TAB_SESSION_CLOSED_CHANNEL,
  TAB_SESSION_INITIAL_CHANNEL,
  TAB_SESSION_RECENT_CHANGED_CHANNEL,
  TAB_SESSION_REOPEN_CHANNEL,
  TAB_SESSION_SAVE_CHANNEL,
  TAB_SESSION_SET_STARTUP_CHANNEL,
  activeTabPathFor,
  bindTabSession,
  claimWindowsToRestore,
  markAppRestart,
  resetTabSessionModule,
  setupTabSession,
} from '..';
import type { SavedTab, TabSessionFile, WindowTabs } from '../schema';

const OWN_URL = 'http://localhost:4242/';
const DAY = 24 * 60 * 60 * 1000;

function tab(id: string, overrides: Partial<SavedTab> = {}): SavedTab {
  const href = overrides.href ?? `/session?session=${id}`;
  return { id, href, history: [href], cursor: 0, lastViewedAt: Date.now(), ...overrides };
}

function sessionPath(): string {
  return join(mockUserDataPath(), 'tab-session.json');
}

function readSession(): TabSessionFile {
  return JSON.parse(readFileSync(sessionPath(), 'utf-8')) as TabSessionFile;
}

function writeSession(file: Partial<TabSessionFile>): void {
  mkdirSync(mockUserDataPath(), { recursive: true });
  writeFileSync(
    sessionPath(),
    JSON.stringify({
      version: 1,
      cleanExit: true,
      relaunch: false,
      startup: 'reopen',
      windows: [],
      recentlyClosed: [],
      ...file,
    })
  );
}

/** The listener the module registered on `channel`. */
function listener(method: 'on' | 'handle', channel: string) {
  const call = vi.mocked(ipcMain[method]).mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`nothing registered on ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

/** An IPC event from `win`'s renderer, on `url`. */
function eventFrom(win: MockBrowserWindow, url = OWN_URL) {
  return {
    sender: { id: win.webContents.id, getURL: () => url },
    returnValue: undefined as unknown,
  };
}

/** Start a run of the app: read the file, answer IPC. */
function launch(): void {
  setupTabSession({ isOwnSender: (event) => event.sender.getURL().startsWith(OWN_URL) });
}

/** Make a window and bind it, the way `createWindow` does. */
function openWindow(tabs: WindowTabs | null, primary: boolean): MockBrowserWindow {
  const win = new BrowserWindow({}) as unknown as MockBrowserWindow;
  bindTabSession(win as unknown as Electron.BrowserWindow, tabs, primary);
  return win;
}

/** The renderer saving its tabs. */
function save(win: MockBrowserWindow, tabs: WindowTabs): void {
  listener('on', TAB_SESSION_SAVE_CHANNEL)(eventFrom(win), tabs);
}

/** End this run the way a quit does: windows close, then `will-quit`. */
async function quit(windows: MockBrowserWindow[]): Promise<void> {
  quitting.value = true;
  for (const win of windows) await win.emit('closed');
  await app.emit('will-quit');
}

/** Forget this run's process state, keeping the file on disk, for the next launch. */
function restartProcess(): void {
  resetTabSessionModule();
  quitting.value = false;
  vi.mocked(ipcMain.on).mockClear();
  vi.mocked(ipcMain.handle).mockClear();
  app.removeAllListeners();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  resetElectronMock();
  restartProcess();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tab session — across launches', () => {
  const twoTabs: WindowTabs = { tabs: [tab('a'), tab('b', { pinned: true })], activeTabId: 'b' };

  it('brings back what a normal quit left, in order, pinned and active intact', async () => {
    launch();
    const win = openWindow(claimWindowsToRestore()[0] ?? null, true);
    save(win, twoTabs);
    await quit([win]);
    expect(readSession().cleanExit).toBe(true);

    restartProcess();
    launch();
    expect(claimWindowsToRestore()).toEqual([twoTabs]);
  });

  it('writes the tabs on change after the debounce, so a crash keeps the last state', () => {
    launch();
    const win = openWindow(null, true);
    save(win, twoTabs);
    vi.advanceTimersByTime(600);
    const file = readSession();
    expect(file.windows).toEqual([twoTabs]);
    // Marked unfinished from the moment the run started.
    expect(file.cleanExit).toBe(false);
  });

  it('restores everything after a crash, even with Start fresh on and week-old tabs', () => {
    const old = tab('old', { lastViewedAt: Date.now() - 30 * DAY });
    writeSession({
      cleanExit: false,
      startup: 'fresh',
      windows: [{ tabs: [old], activeTabId: 'old' }],
    });
    launch();
    expect(claimWindowsToRestore()).toEqual([{ tabs: [old], activeTabId: 'old' }]);
    expect(readSession().recentlyClosed).toEqual([]);
  });

  it('restores everything after an app restart (an update), whatever the setting', async () => {
    launch();
    listener('handle', TAB_SESSION_SET_STARTUP_CHANNEL)(
      eventFrom(openWindow(null, false)),
      'fresh'
    );
    const win = openWindow(null, true);
    save(win, twoTabs);
    markAppRestart();
    // The update closes every window before the app quits: that is the
    // restart, not the person closing tabs, even though `before-quit` is late.
    quitting.value = false;
    await win.emit('closed');
    await app.emit('will-quit');
    expect(readSession()).toMatchObject({ relaunch: true, recentlyClosed: [] });

    restartProcess();
    launch();
    expect(claimWindowsToRestore()).toEqual([twoTabs]);
  });

  it('writes at once on an app restart, so the relaunch cannot outrun the debounce', () => {
    launch();
    const win = openWindow(null, true);
    save(win, twoTabs);
    markAppRestart();
    // No timer advanced.
    expect(readSession()).toMatchObject({ relaunch: true, windows: [twoTabs] });
  });

  it('on Start fresh, opens one home tab and files the old tabs under Recently closed', async () => {
    writeSession({ startup: 'fresh', windows: [twoTabs] });
    launch();
    expect(claimWindowsToRestore()).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(readSession().recentlyClosed.map((entry) => entry.tab.id)).toEqual(['b', 'a']);
  });

  it('moves an unpinned tab unseen for over 7 days to Recently closed at a normal launch', () => {
    const stale = tab('stale', { lastViewedAt: Date.now() - 8 * DAY });
    const pinned = tab('pinned', { pinned: true, lastViewedAt: Date.now() - 8 * DAY });
    writeSession({ windows: [{ tabs: [pinned, stale], activeTabId: 'stale' }] });
    launch();
    const launchedAt = Date.now();
    expect(claimWindowsToRestore()).toEqual([{ tabs: [pinned], activeTabId: 'pinned' }]);
    vi.advanceTimersByTime(600);
    expect(readSession().recentlyClosed).toEqual([{ tab: stale, index: 1, closedAt: launchedAt }]);
  });

  it('opens on one home tab when the file is corrupt, and replaces it with a good one', () => {
    mkdirSync(mockUserDataPath(), { recursive: true });
    writeFileSync(sessionPath(), '{ not json');
    launch();
    expect(claimWindowsToRestore()).toEqual([]);
    expect(readSession().version).toBe(1);
  });

  it('opens on one home tab when the file is from an incompatible version', () => {
    writeSession({ version: 99 as 1, windows: [twoTabs] });
    launch();
    expect(claimWindowsToRestore()).toEqual([]);
  });

  it('restores several windows, each with its own tabs, primary first', async () => {
    launch();
    const primary = openWindow(null, true);
    const second = openWindow(null, false);
    const other: WindowTabs = { tabs: [tab('x')], activeTabId: 'x' };
    save(second, other);
    save(primary, twoTabs);
    await quit([second, primary]);

    restartProcess();
    launch();
    expect(claimWindowsToRestore()).toEqual([twoTabs, other]);
  });
});

describe('tab session — while running', () => {
  it('gives a window its tabs back on a reload, and none to a window it never saw', () => {
    launch();
    const tabs: WindowTabs = { tabs: [tab('a')], activeTabId: 'a' };
    const win = openWindow(tabs, true);
    const initial = listener('on', TAB_SESSION_INITIAL_CHANNEL);

    const event = eventFrom(win);
    initial(event);
    expect(event.returnValue).toEqual(tabs);

    const fresh = eventFrom(openWindow(null, false));
    initial(fresh);
    expect(fresh.returnValue).toBeNull();
  });

  it('loads a window straight onto its front tab', () => {
    launch();
    const win = openWindow({ tabs: [tab('a'), tab('b')], activeTabId: 'b' }, true);
    expect(activeTabPathFor(win as unknown as Electron.BrowserWindow)).toBe('/session?session=b');
  });

  it('answers nothing to a page that is not the app’s own', () => {
    launch();
    const win = openWindow({ tabs: [tab('a')], activeTabId: 'a' }, true);
    const event = eventFrom(win, 'https://elsewhere.example/');
    listener('on', TAB_SESSION_INITIAL_CHANNEL)(event);
    expect(event.returnValue).toBeNull();
    listener('on', TAB_SESSION_SAVE_CHANNEL)(event, { tabs: [tab('evil')], activeTabId: 'evil' });
    expect(activeTabPathFor(win as unknown as Electron.BrowserWindow)).toBe('/session?session=a');
  });

  it('ignores a save that is not a tab list', () => {
    launch();
    const tabs: WindowTabs = { tabs: [tab('a')], activeTabId: 'a' };
    const win = openWindow(tabs, true);
    listener('on', TAB_SESSION_SAVE_CHANNEL)(eventFrom(win), { tabs: 'nope' });
    listener('on', TAB_SESSION_SAVE_CHANNEL)(eventFrom(win), {
      tabs: [tab('x', { href: 'https://evil.example', history: ['https://evil.example'] })],
      activeTabId: 'x',
    });
    expect(activeTabPathFor(win as unknown as Electron.BrowserWindow)).toBe('/session?session=a');
  });

  it('files closed tabs under Recently closed, newest first, and tells every window', () => {
    launch();
    const win = openWindow(null, true);
    listener('on', TAB_SESSION_CLOSED_CHANNEL)(eventFrom(win), [
      { tab: tab('a'), index: 0 },
      { tab: tab('b'), index: 1 },
    ]);
    expect(win.webContents.send).toHaveBeenCalledWith(
      TAB_SESSION_RECENT_CHANGED_CHANNEL,
      expect.arrayContaining([expect.objectContaining({ index: 1 })])
    );
    vi.advanceTimersByTime(600);
    expect(readSession().recentlyClosed.map((entry) => entry.tab.id)).toEqual(['b', 'a']);
  });

  it('takes a tab back out of Recently closed when reopened, once', async () => {
    launch();
    const win = openWindow(null, true);
    listener('on', TAB_SESSION_CLOSED_CHANNEL)(eventFrom(win), [{ tab: tab('a'), index: 2 }]);
    const reopen = listener('handle', TAB_SESSION_REOPEN_CHANNEL);
    expect(await reopen(eventFrom(win))).toMatchObject({ tab: { id: 'a' }, index: 2 });
    expect(await reopen(eventFrom(win))).toBeNull();
  });

  it('files a window closed while others stay open under Recently closed', async () => {
    launch();
    const primary = openWindow(null, true);
    const second = openWindow(null, false);
    save(second, { tabs: [tab('x'), tab('y')], activeTabId: 'y' });
    await second.emit('closed');
    vi.advanceTimersByTime(600);
    const file = readSession();
    expect(file.recentlyClosed.map((entry) => entry.tab.id)).toEqual(['y', 'x']);
    expect(file.windows).toEqual([]);
    expect(primary).toBeTruthy();
  });

  it('keeps the last window’s tabs when it closes, for the next window to reopen', async () => {
    launch();
    claimWindowsToRestore();
    const tabs: WindowTabs = { tabs: [tab('a')], activeTabId: 'a' };
    const win = openWindow(null, true);
    save(win, tabs);
    await win.emit('closed');
    expect(readSession().recentlyClosed).toEqual([]);
    // Reopened from the tray: the same rules as a normal launch.
    expect(claimWindowsToRestore()).toEqual([tabs]);
  });

  it('applies Start fresh when the last window is reopened from the tray', async () => {
    launch();
    claimWindowsToRestore();
    const win = openWindow(null, true);
    listener('handle', TAB_SESSION_SET_STARTUP_CHANNEL)(eventFrom(win), 'fresh');
    save(win, { tabs: [tab('a')], activeTabId: 'a' });
    await win.emit('closed');
    expect(claimWindowsToRestore()).toEqual([]);
  });

  it('refuses a startup mode that is not one of the two', async () => {
    launch();
    const set = listener('handle', TAB_SESSION_SET_STARTUP_CHANNEL);
    expect(await set(eventFrom(openWindow(null, true)), 'sometimes')).toBeNull();
    expect(readSession().startup).toBe('reopen');
  });

  it('puts the run on disk as unfinished the moment it starts', () => {
    launch();
    expect(existsSync(sessionPath())).toBe(true);
    expect(readSession().cleanExit).toBe(false);
  });
});
