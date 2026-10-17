/**
 * Recently closed tabs: the safety net under every way a tab can go.
 *
 * The desktop shell keeps the list (`main/tab-session/` in the desktop app),
 * shared by every window and kept across quits: tabs the person closed, a
 * window closed while others stay open, tabs a launch left out because nobody
 * looked at them for a week, restored tabs whose page seemed gone, and the
 * whole strip when DorkOS is set to start fresh. This module is the renderer's half: it reports closes, mirrors the
 * list for the tab menu, and brings a tab back.
 *
 * **Desktop shell only**, like the tabs themselves. Outside it there is no
 * bridge, the list stays empty, and every call here does nothing.
 *
 * @module features/app-tabs/model/recently-closed
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { useAppTabsStore, type AppTab } from '@/layers/shared/model';
import { goToActiveTab, type TabRouter } from './tab-navigation';

/** The shell's half of Recently closed, when there is a shell. */
function bridge() {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.tabSession;
}

/** Recently closed as this window last heard it, newest first. */
export const useRecentlyClosedStore = create<{ entries: DesktopClosedTab[] }>(() => ({
  entries: [],
}));

/** Subscribe to Recently closed, newest first. Empty outside the desktop app. */
export function useRecentlyClosed(): DesktopClosedTab[] {
  return useRecentlyClosedStore((s) => s.entries);
}

/**
 * Keep this window's copy of Recently closed current. Mounted once, by the
 * shell. Reads the list once and then follows every change, from any window.
 */
export function useRecentlyClosedSync(): void {
  useEffect(() => {
    const shell = bridge();
    if (!shell) return;
    let live = true;
    const unsubscribe = shell.onRecentlyClosedChange((entries) => {
      useRecentlyClosedStore.setState({ entries });
    });
    void shell.getRecentlyClosed().then((entries) => {
      if (live) useRecentlyClosedStore.setState({ entries });
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
}

/**
 * Report the tabs a change closed: every tab in `before` that `after` no longer
 * has, with the index it sat at.
 *
 * @param before - The tab list before the close.
 * @param after - The tab list after it.
 */
export function recordClosedTabs(before: readonly AppTab[], after: readonly AppTab[]): void {
  const shell = bridge();
  if (!shell) return;
  const kept = new Set(after.map((tab) => tab.id));
  const closed = before.flatMap((tab, index) => (kept.has(tab.id) ? [] : [{ tab, index }]));
  if (closed.length === 0) return;
  try {
    shell.recordClosed(closed);
  } catch (error) {
    // Losing one entry from a safety net is not worth interrupting a close.
    console.error('[dorkos:tabs] could not record a closed tab', error);
  }
}

/** Which Recently closed entry to bring back: its tab id and when it closed. */
export interface ClosedTabKey {
  tabId: string;
  closedAt: number;
}

/**
 * Bring a closed tab back into this window, where it was, and go to it.
 *
 * @param router - The router to navigate with.
 * @param key - Which entry. Defaults to the newest.
 * @returns Whether a tab came back.
 */
export async function reopenClosedTab(router: TabRouter, key?: ClosedTabKey): Promise<boolean> {
  const shell = bridge();
  if (!shell) return false;
  const entry = await shell.reopen(key);
  if (!entry) return false;
  const before = useAppTabsStore.getState().activeTabId;
  useAppTabsStore.getState().reopenTab(entry.tab, entry.index);
  if (useAppTabsStore.getState().activeTabId === before) return false;
  goToActiveTab(router);
  return true;
}
