import { useMemo, useEffect } from 'react';
import {
  useAppStore,
  useSlotContributions,
  type SidebarTabContribution,
} from '@/layers/shared/model';
import { BUILTIN_SIDEBAR_TAB_IDS, isBuiltinSidebarTab } from './sidebar-contributions';

/** The tab the sidebar always falls back to — the first built-in, never hidden. */
const FALLBACK_TAB = 'overview';

/**
 * Grace window before an unrenderable contributed tab is reconciled to the
 * fallback. A programmatic switch to an extension tab (a Shape apply dispatches
 * `switch_sidebar_tab` BEFORE it remounts the extension) briefly targets a tab
 * that hasn't registered yet; this window lets the extension register and the
 * tab land, while a genuinely orphaned id (extension uninstalled) still falls
 * back once the window elapses.
 */
const CONTRIBUTED_TAB_GRACE_MS = 2000;

interface SidebarTabsResult {
  /** Visible tab contributions (built-ins + extensions), sorted by priority. */
  visibleTabs: SidebarTabContribution[];
  /** The active tab id — a built-in or a contributed `${extId}:${id}`. */
  sidebarActiveTab: string;
  setSidebarActiveTab: (tab: string) => void;
}

/**
 * Manage sidebar tab visibility, selection, and keyboard shortcuts.
 *
 * - Queries the extension registry for `sidebar.tabs` contributions (built-ins
 *   plus any extension tabs), filtered by their `visibleWhen` predicates.
 * - Reconciles a stale active tab back to {@link FALLBACK_TAB}: a hidden
 *   built-in (e.g. Schedules when Tasks is off) falls back immediately; a
 *   contributed id that isn't rendered yet gets a {@link CONTRIBUTED_TAB_GRACE_MS}
 *   window to appear (winning the Shape-apply remount race) before falling back.
 * - Registers Cmd/Ctrl+1–4 for the four built-in tabs while the sidebar is open.
 */
export function useSidebarTabs(): SidebarTabsResult {
  const { sidebarActiveTab, setSidebarActiveTab } = useAppStore();
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const allTabs = useSlotContributions('sidebar.tabs');

  const visibleTabs = useMemo(
    () => allTabs.filter((tab) => !tab.visibleWhen || tab.visibleWhen()),
    [allTabs]
  );

  const activeIsRenderable = useMemo(
    () => visibleTabs.some((tab) => tab.id === sidebarActiveTab),
    [visibleTabs, sidebarActiveTab]
  );

  // Reconcile a stale active tab back to the fallback.
  useEffect(() => {
    if (activeIsRenderable || sidebarActiveTab === FALLBACK_TAB) return;

    // A built-in hidden by its own predicate (Schedules when Tasks is disabled)
    // is genuinely gone now — fall back immediately.
    if (isBuiltinSidebarTab(sidebarActiveTab)) {
      setSidebarActiveTab(FALLBACK_TAB);
      return;
    }

    // A contributed id may be a switch that landed just before its extension
    // (re)registered. Give it a grace window; if the tab appears, this effect
    // re-runs with `activeIsRenderable` true and clears the pending fallback.
    const timer = setTimeout(() => setSidebarActiveTab(FALLBACK_TAB), CONTRIBUTED_TAB_GRACE_MS);
    return () => clearTimeout(timer);
  }, [activeIsRenderable, sidebarActiveTab, setSidebarActiveTab]);

  // Keyboard shortcuts for the four built-in tabs (Cmd/Ctrl + 1/2/3/4). Kept
  // bound to built-ins by index so the number that selects a tab never shifts
  // when extension tabs are installed.
  useEffect(() => {
    if (!sidebarOpen) return;

    const visibleIds = new Set(visibleTabs.map((tab) => tab.id));
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const index = Number(e.key) - 1;
      const tabId = BUILTIN_SIDEBAR_TAB_IDS[index];
      if (tabId && visibleIds.has(tabId)) {
        e.preventDefault();
        setSidebarActiveTab(tabId);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen, visibleTabs, setSidebarActiveTab]);

  return { visibleTabs, sidebarActiveTab, setSidebarActiveTab };
}
