/**
 * Everything the desktop tab strip needs running behind it, mounted once by
 * the app shell.
 *
 * - `useAppTabsSync` — the single reconciliation point between the router's
 *   location and the tab set: every navigation, whatever started it, lands
 *   there.
 * - `useAppTabShortcuts` and `useTabHistoryShortcuts` — the tab keys, and each
 *   tab's own Back and Forward (DOR-2107).
 * - `useRecentlyClosedSync` — this window's copy of Recently closed.
 * - `usePruneMissingTabs` — restored tabs whose page is gone, dropped quietly.
 *
 * Each no-ops outside the desktop shell, where the strip does not exist
 * (DOR-568), so the shell mounts this unconditionally.
 *
 * @module features/app-tabs/model/use-app-tabs-shell
 */
import { useAppTabsSync } from './use-app-tabs-sync';
import { useAppTabShortcuts } from './use-app-tab-shortcuts';
import { useTabHistoryShortcuts } from './use-tab-history-shortcuts';
import { useRecentlyClosedSync } from './recently-closed';
import { usePruneMissingTabs } from './use-prune-missing-tabs';

/** Run the tab strip's background work for as long as the shell is mounted. */
export function useAppTabsShell(): void {
  useAppTabsSync();
  useAppTabShortcuts();
  useRecentlyClosedSync();
  usePruneMissingTabs();
  useTabHistoryShortcuts();
}
