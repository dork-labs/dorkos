import { app, BrowserWindow, ipcMain } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import log from 'electron-log';
import { isQuitting } from '../quit-guard';
import {
  addRecentlyClosed,
  launchKindOf,
  planRestore,
  setAsideWindow,
  type LaunchKind,
} from './restore-plan';
import {
  ClosedTabSchema,
  emptyTabSession,
  parseTabSessionFile,
  parseWindowTabs,
  StartupModeSchema,
  type ClosedTab,
  type StartupMode,
  type TabSessionFile,
  type WindowTabs,
} from './schema';

/**
 * Remembering every window's tabs across quits, restarts and crashes.
 *
 * The renderer's tab store used to live in `sessionStorage` alone, which dies
 * with the app: an update closed DorkOS, reopened it, and every tab was gone.
 * `localStorage` would not do either, because a packaged build is served from
 * `http://localhost:<port>` and the port can change between launches, which
 * changes the origin and hides the old storage. So the main process keeps the
 * session, in `tab-session.json` beside `window-state.json` in `userData`.
 *
 * **How it flows.** Every window is bound here when it is made
 * (`createWindow`). Its renderer reads its tabs once, synchronously, before the
 * store is built (`tab-session:initial`), and sends the whole tab list back on
 * every change (`tab-session:save`). Writes to disk are debounced; a quit and an
 * app restart flush at once, so a relaunch cannot race the write.
 *
 * **What comes back** is `restore-plan.ts`: everything after the app restarted
 * itself or crashed, and the person's choice after a normal quit. Only the tab
 * in front loads: background tabs are inert locations until clicked, which the
 * store already guarantees.
 *
 * **Closing things.** A tab the person closes, a window closed while others
 * stay open, a stale tab and a Start fresh launch all go to Recently closed,
 * which every window can reopen from. The last window closing is not closing
 * its tabs: DorkOS keeps running in the tray, and the next window brings them
 * back by the same rules as a launch.
 *
 * @module main/tab-session
 */

/** A renderer reads its window's tabs here, synchronously, once per page load. */
export const TAB_SESSION_INITIAL_CHANNEL = 'tab-session:initial';
/** A renderer sends its window's whole tab list here on every change. */
export const TAB_SESSION_SAVE_CHANNEL = 'tab-session:save';
/** A renderer reports tabs the person closed here. */
export const TAB_SESSION_CLOSED_CHANNEL = 'tab-session:closed';
/** A renderer takes one tab back out of Recently closed here. */
export const TAB_SESSION_REOPEN_CHANNEL = 'tab-session:reopen';
/** A renderer reads Recently closed here, once, when it mounts. */
export const TAB_SESSION_RECENT_CHANNEL = 'tab-session:recently-closed';
/** The main process pushes Recently closed to every window here when it changes. */
export const TAB_SESSION_RECENT_CHANGED_CHANNEL = 'tab-session:recently-closed-changed';
/** A renderer reads the "When DorkOS opens" setting here. */
export const TAB_SESSION_GET_STARTUP_CHANNEL = 'tab-session:get-startup';
/** A renderer changes the "When DorkOS opens" setting here. */
export const TAB_SESSION_SET_STARTUP_CHANNEL = 'tab-session:set-startup';

/** Debounce for disk writes, so a burst of tab changes is one write. */
const SAVE_DEBOUNCE_MS = 500;

/** Where the session lives. Resolved lazily so tests can mock `app` first. */
function sessionFile(): string {
  return join(app.getPath('userData'), 'tab-session.json');
}

/** One window this run knows about. */
interface Slot {
  /** Sort key: the primary window is 0, so it is always written first. */
  order: number;
  /** Its tabs, or `null` before its renderer has said anything. */
  tabs: WindowTabs | null;
}

/** The file as this run will next write it. */
let session: TabSessionFile = emptyTabSession();
/** How the last run ended, read once at {@link setupTabSession}. */
let launchKind: LaunchKind = 'normal';
/** Whether the launch has been planned; every later plan is a window reopening. */
let launchPlanned = false;
/** Windows that are open, by `webContents.id`. */
const live = new Map<number, Slot>();
/** Windows kept with no window on screen: the last run's, or the last one closed. */
let detached: Slot[] = [];
/** Next order for a secondary window. */
let nextOrder = 1;
/** Set by {@link markAppRestart}: windows closing from here on are the app restarting. */
let restarting = false;
/** The pending debounced write. */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether {@link setupTabSession} has run. */
let initialised = false;

/** Every window's tabs, primary first: open windows and kept ones alike. */
function allWindows(): WindowTabs[] {
  return [...live.values(), ...detached]
    .filter((slot): slot is Slot & { tabs: WindowTabs } => slot.tabs !== null)
    .sort((a, b) => a.order - b.order)
    .map((slot) => slot.tabs);
}

/** Write the file now. A failure costs the next launch its tabs, never this run. */
function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  session = { ...session, windows: allWindows() };
  const file = sessionFile();
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    // Written beside and renamed over, so a crash mid-write leaves the old file
    // whole rather than a half-written one the next launch has to throw away.
    writeFileSync(`${file}.tmp`, JSON.stringify(session));
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    log.warn('[tabs] Could not save the open tabs.', err);
  }
}

/** Write soon, folding a burst of changes into one write. */
function scheduleWrite(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

/** Tell every window what Recently closed holds now. */
function broadcastRecentlyClosed(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !live.has(win.webContents.id)) continue;
    win.webContents.send(TAB_SESSION_RECENT_CHANGED_CHANNEL, session.recentlyClosed);
  }
}

/** Put tabs at the front of Recently closed, then save and tell every window. */
function fileUnderRecentlyClosed(closed: ClosedTab[]): void {
  if (closed.length === 0) return;
  session = { ...session, recentlyClosed: addRecentlyClosed(session.recentlyClosed, closed) };
  broadcastRecentlyClosed();
  scheduleWrite();
}

/** Read the file at launch, or start empty when there is none or it is unusable. */
function readSessionFile(): TabSessionFile {
  let raw: string;
  try {
    raw = readFileSync(sessionFile(), 'utf-8');
  } catch {
    return emptyTabSession();
  }
  try {
    const parsed = parseTabSessionFile(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // Falls through to the warning below.
  }
  log.warn('[tabs] The saved tabs could not be read; opening on a fresh tab.');
  return emptyTabSession();
}

/** Options for {@link setupTabSession}. */
export interface TabSessionOptions {
  /** Whether a message came from one of the app's own pages. */
  isOwnSender: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
}

/**
 * Read the last session and answer the renderer's questions about it. Call
 * once, before any window is made.
 *
 * Marks this run as not yet cleanly ended straight away, so a crash anywhere
 * after this line restores everything next time.
 *
 * @param options - See {@link TabSessionOptions}.
 */
export function setupTabSession(options: TabSessionOptions): void {
  if (initialised) return;
  initialised = true;
  const previous = readSessionFile();
  launchKind = launchKindOf(previous);
  detached = previous.windows.map((tabs, index) => ({
    order: index === 0 ? 0 : nextOrder++,
    tabs,
  }));
  session = { ...previous, cleanExit: false, relaunch: false };
  flush();

  ipcMain.on(TAB_SESSION_INITIAL_CHANNEL, (event) => {
    event.returnValue = options.isOwnSender(event)
      ? (live.get(event.sender.id)?.tabs ?? null)
      : null;
  });

  ipcMain.on(TAB_SESSION_SAVE_CHANNEL, (event, raw: unknown) => {
    if (!options.isOwnSender(event)) return;
    const slot = live.get(event.sender.id);
    const tabs = parseWindowTabs(raw);
    if (!slot || !tabs) return;
    slot.tabs = tabs;
    scheduleWrite();
  });

  ipcMain.on(TAB_SESSION_CLOSED_CHANNEL, (event, raw: unknown) => {
    if (!options.isOwnSender(event) || !Array.isArray(raw)) return;
    const now = Date.now();
    // Newest first: the renderer lists them in strip order, and the last one in
    // the strip is as good a "most recent" as any for tabs closed together.
    const closed = raw
      .map((entry) => ClosedTabSchema.safeParse({ ...(entry as object), closedAt: now }))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .reverse();
    fileUnderRecentlyClosed(closed);
  });

  ipcMain.handle(TAB_SESSION_REOPEN_CHANNEL, (event, rawIndex: unknown): ClosedTab | null => {
    if (!options.isOwnSender(event)) return null;
    const index = rawIndex === undefined ? 0 : rawIndex;
    if (!Number.isInteger(index)) return null;
    const entry = session.recentlyClosed[index as number];
    if (!entry) return null;
    session = {
      ...session,
      recentlyClosed: session.recentlyClosed.filter((_, i) => i !== index),
    };
    broadcastRecentlyClosed();
    scheduleWrite();
    return entry;
  });

  ipcMain.handle(TAB_SESSION_RECENT_CHANNEL, (event): ClosedTab[] =>
    options.isOwnSender(event) ? session.recentlyClosed : []
  );

  ipcMain.handle(TAB_SESSION_GET_STARTUP_CHANNEL, (event): StartupMode | null =>
    options.isOwnSender(event) ? session.startup : null
  );

  ipcMain.handle(TAB_SESSION_SET_STARTUP_CHANNEL, (event, raw: unknown): StartupMode | null => {
    if (!options.isOwnSender(event)) return null;
    const parsed = StartupModeSchema.safeParse(raw);
    if (!parsed.success) return null;
    session = { ...session, startup: parsed.data };
    flush();
    return parsed.data;
  });

  // After every window has closed and before the process goes: the only point
  // where "this run ended cleanly" is true. A restart the app asked for keeps
  // its mark, so the next launch restores everything whatever the setting.
  app.on('will-quit', () => {
    session = { ...session, cleanExit: true, relaunch: restarting };
    flush();
  });
}

/**
 * Take the windows to open now: the last run's at launch, or the tabs of the
 * last window closed when DorkOS opens a window again from the tray or the
 * Dock. The plan runs here, so the setting is read at the moment it applies.
 *
 * @returns The windows to open, primary first. Empty means one home tab.
 */
export function claimWindowsToRestore(): WindowTabs[] {
  const kind: LaunchKind = launchPlanned ? 'normal' : launchKind;
  launchPlanned = true;
  const kept = detached
    .filter((slot): slot is Slot & { tabs: WindowTabs } => slot.tabs !== null)
    .sort((a, b) => a.order - b.order)
    .map((slot) => slot.tabs);
  detached = [];
  const plan = planRestore(kept, { kind, startup: session.startup, now: Date.now() });
  if (plan.closed.length > 0) {
    log.info(`[tabs] ${plan.closed.length} tab(s) went to Recently closed at launch.`);
  }
  session = { ...session, recentlyClosed: addRecentlyClosed(session.recentlyClosed, plan.closed) };
  scheduleWrite();
  return plan.windows;
}

/**
 * Remember a new window's tabs from now on.
 *
 * @param win - The window, just made.
 * @param tabs - The tabs it opens with, or `null` for a window that starts on
 *   wherever it was opened.
 * @param primary - Whether this is the primary window, which is written first.
 */
export function bindTabSession(
  win: BrowserWindow,
  tabs: WindowTabs | null,
  primary: boolean
): void {
  // Read now: by `closed` the webContents is gone and its id with it.
  const contentsId = win.webContents.id;
  const slot: Slot = { order: primary ? 0 : nextOrder++, tabs };
  live.set(contentsId, slot);
  win.on('closed', () => {
    if (live.get(contentsId) !== slot) return;
    live.delete(contentsId);
    if (slot.tabs) {
      // The app on its way out, or the last window going while DorkOS stays in
      // the tray: these tabs are the session, kept for the next window. One
      // window of several closing is the person closing those tabs.
      if (restarting || isQuitting() || live.size === 0) detached.push(slot);
      else fileUnderRecentlyClosed(setAsideWindow(slot.tabs, Date.now()));
    }
    scheduleWrite();
  });
}

/**
 * The location a window's front tab holds, for the window to load straight
 * onto. `undefined` for a window with no tabs yet.
 *
 * @param win - The window about to load.
 */
export function activeTabPathFor(win: BrowserWindow): string | undefined {
  const tabs = live.get(win.webContents.id)?.tabs;
  return tabs?.tabs.find((tab) => tab.id === tabs.activeTabId)?.href;
}

/**
 * Say the app is about to restart itself: an update, a renderer recovery, a
 * move into Applications. Every window closing from here on is kept, and the
 * next launch restores everything whatever the setting. Writes at once, so
 * the restart cannot outrun it.
 */
export function markAppRestart(): void {
  restarting = true;
  session = { ...session, relaunch: true };
  flush();
}

/**
 * Forget everything this module holds, for a test to start over.
 *
 * @internal Exported for testing only.
 */
export function resetTabSessionModule(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  session = emptyTabSession();
  launchKind = 'normal';
  launchPlanned = false;
  live.clear();
  detached = [];
  nextOrder = 1;
  restarting = false;
  initialised = false;
}

/** Re-exported for the preload's types. */
export type { ClosedTab, StartupMode, WindowTabs };
