/**
 * Back, Forward and History for the active tab (DOR-2107) — the one
 * implementation behind the header buttons, the History menu, the keys and the
 * mouse side buttons.
 *
 * Every move goes in the same order as the tab actions: change the store, then
 * navigate. The store sets the active tab's cursor and href together
 * (`goToHistoryIndex`), so when the location change comes back through
 * `useAppTabsSync` the tab is already there (rule 1) and nothing is recorded. If
 * the page then redirects, the router reports a `REPLACE` and the entry is
 * rewritten in place.
 *
 * @module features/app-tabs/model/tab-history
 */
import { useAppTabsStore } from '@/layers/shared/model';
import { goToActiveTab, type TabRouter } from './tab-navigation';

/** The active tab's cursor, or `null` when the window has no active tab. */
function activeCursor(): number | null {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  return tabs.find((tab) => tab.id === activeTabId)?.cursor ?? null;
}

/**
 * Move the active tab to history entry `index` and go there. Does nothing —
 * not even a navigation — when the store did not move, so Back on the first
 * page is silent rather than a reload.
 */
function moveTo(router: TabRouter, index: number): void {
  const before = activeCursor();
  if (before === null) return;
  useAppTabsStore.getState().goToHistoryIndex(index);
  if (activeCursor() === before) return;
  goToActiveTab(router);
}

/**
 * Take the active tab back one page.
 *
 * @param router - The router to drive.
 */
export function goBack(router: TabRouter): void {
  const cursor = activeCursor();
  if (cursor !== null) moveTo(router, cursor - 1);
}

/**
 * Take the active tab forward one page.
 *
 * @param router - The router to drive.
 */
export function goForward(router: TabRouter): void {
  const cursor = activeCursor();
  if (cursor !== null) moveTo(router, cursor + 1);
}

/**
 * Take the active tab to any page in its history — the History menu's jump.
 *
 * @param router - The router to drive.
 * @param index - Position in the active tab's history, oldest first.
 */
export function goToHistoryEntry(router: TabRouter, index: number): void {
  moveTo(router, index);
}
