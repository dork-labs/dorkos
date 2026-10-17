import {
  MAX_RECENTLY_CLOSED,
  STALE_TAB_MS,
  type ClosedTab,
  type SavedTab,
  type StartupMode,
  type TabSessionFile,
  type WindowTabs,
} from './schema';

/**
 * Which tabs come back when DorkOS opens, as one pure decision.
 *
 * | How the app last ended                       | Reopen your tabs           | Start fresh             |
 * | -------------------------------------------- | -------------------------- | ----------------------- |
 * | The app restarted itself (update, recovery)  | everything                 | everything              |
 * | It crashed (the quit never finished)         | everything                 | everything              |
 * | A normal quit, or the last window closed     | all but stale unpinned tabs | nothing; all to Recently closed |
 *
 * "Stale" is an unpinned tab nobody looked at for {@link STALE_TAB_MS}.
 * Pinned tabs never go stale. Nothing a launch leaves behind is lost: it goes
 * to Recently closed, newest first.
 *
 * Tabs whose target is gone (a deleted chat, a room you left) are not judged
 * here. Only the renderer can ask the server, so it drops them itself once it
 * has (`usePruneMissingTabs` in the client).
 *
 * @module main/tab-session/restore-plan
 */

/** Whether the last run ended the way a person meant it to. */
export type LaunchKind = 'relaunch' | 'normal';

/**
 * Read how the last run ended from the file it left.
 *
 * A relaunch the app asked for, and a crash, both restore everything: neither
 * was a person choosing to close their tabs.
 *
 * @param file - The file as it was read at launch, before this run wrote to it.
 */
export function launchKindOf(file: Pick<TabSessionFile, 'cleanExit' | 'relaunch'>): LaunchKind {
  return file.relaunch || !file.cleanExit ? 'relaunch' : 'normal';
}

/** What to open, and what to file under Recently closed. */
export interface RestorePlan {
  /** Windows to open, the first being the primary. Empty means one home tab. */
  windows: WindowTabs[];
  /** Tabs set aside, newest first, to put in front of Recently closed. */
  closed: ClosedTab[];
}

/** Inputs to {@link planRestore}. */
export interface RestoreContext {
  kind: LaunchKind;
  startup: StartupMode;
  /** The clock, in ms since the epoch. */
  now: number;
}

/**
 * When a tab was last seen. A tab with no stamp (saved before stamping
 * existed) counts as seen now, so an upgrade never sweeps a whole strip away.
 */
function lastViewed(tab: SavedTab, now: number): number {
  return tab.lastViewedAt ?? now;
}

/**
 * One window's tabs, every one set aside, the tab that was in front first, so
 * reopening one brings back what the person was last looking at.
 *
 * @param win - The window whose tabs are going.
 * @param now - The clock, in ms since the epoch.
 */
export function setAsideWindow(win: WindowTabs, now: number): ClosedTab[] {
  const entries = win.tabs.map((tab, index) => ({ tab, index, closedAt: now }));
  const front = entries.findIndex((entry) => entry.tab.id === win.activeTabId);
  if (front <= 0) return entries;
  return [entries[front], ...entries.slice(0, front), ...entries.slice(front + 1)];
}

/**
 * Keep one window's fresh and pinned tabs, and set aside the stale ones.
 * When the tab that was in front goes, the most recently seen tab left takes
 * its place.
 */
function tidyWindow(
  win: WindowTabs,
  now: number
): { kept: WindowTabs | null; closed: ClosedTab[] } {
  const closed: ClosedTab[] = [];
  const tabs = win.tabs.filter((tab, index) => {
    const fresh = tab.pinned === true || now - lastViewed(tab, now) <= STALE_TAB_MS;
    if (!fresh) closed.push({ tab, index, closedAt: now });
    return fresh;
  });
  if (tabs.length === 0) return { kept: null, closed };
  const activeTabId = tabs.some((tab) => tab.id === win.activeTabId)
    ? win.activeTabId
    : tabs.reduce((best, tab) => (lastViewed(tab, now) > lastViewed(best, now) ? tab : best)).id;
  return { kept: { tabs, activeTabId }, closed };
}

/**
 * Decide what a launch (or a window reopened after the last one closed) brings
 * back. See the module doc for the table.
 *
 * @param windows - The windows the last run left, primary first.
 * @param context - How the last run ended, the setting, and the clock.
 */
export function planRestore(windows: WindowTabs[], context: RestoreContext): RestorePlan {
  const { kind, startup, now } = context;
  if (kind === 'relaunch') return { windows, closed: [] };
  if (startup === 'fresh') {
    return { windows: [], closed: windows.flatMap((win) => setAsideWindow(win, now)) };
  }
  const kept: WindowTabs[] = [];
  const closed: ClosedTab[] = [];
  for (const win of windows) {
    const result = tidyWindow(win, now);
    if (result.kept) kept.push(result.kept);
    closed.push(...result.closed);
  }
  return { windows: kept, closed };
}

/**
 * Put newly closed tabs at the front of Recently closed, newest first, and
 * keep the list to {@link MAX_RECENTLY_CLOSED}.
 *
 * @param list - Recently closed as it stands.
 * @param added - Tabs to add, already newest first.
 */
export function addRecentlyClosed(
  list: readonly ClosedTab[],
  added: readonly ClosedTab[]
): ClosedTab[] {
  return [...added, ...list].slice(0, MAX_RECENTLY_CLOSED);
}
