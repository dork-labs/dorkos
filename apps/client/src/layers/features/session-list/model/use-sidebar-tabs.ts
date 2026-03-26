import { useMemo, useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/** Tab identifiers for the session sidebar. */
export type SidebarTab = 'overview' | 'sessions' | 'schedules' | 'connections';

interface SidebarTabsResult {
  visibleTabs: SidebarTab[];
  sidebarActiveTab: SidebarTab;
  setSidebarActiveTab: (tab: SidebarTab) => void;
}

/**
 * Manage sidebar tab visibility, selection, and keyboard shortcuts.
 *
 * - Computes visible tabs based on feature flags (Pulse tool status).
 * - Falls back to 'overview' if the active tab becomes hidden.
 * - Registers Cmd/Ctrl+1/2/3/4 shortcuts when the sidebar is open.
 *
 * @param pulseToolEnabled - Whether the Pulse tool is available for this agent.
 */
export function useSidebarTabs(pulseToolEnabled: boolean): SidebarTabsResult {
  const { sidebarActiveTab, setSidebarActiveTab } = useAppStore();
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);

  const visibleTabs = useMemo(() => {
    const tabs: SidebarTab[] = ['overview', 'sessions'];
    if (pulseToolEnabled) tabs.push('schedules');
    // Connections always visible (Mesh has no server feature flag)
    tabs.push('connections');
    return tabs;
  }, [pulseToolEnabled]);

  // Fall back to 'overview' if active tab becomes hidden due to feature flag changes
  useEffect(() => {
    if (!visibleTabs.includes(sidebarActiveTab)) {
      setSidebarActiveTab('overview');
    }
  }, [visibleTabs, sidebarActiveTab, setSidebarActiveTab]);

  // Keyboard shortcuts for sidebar tab switching (Cmd/Ctrl + 1/2/3/4)
  useEffect(() => {
    if (!sidebarOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const tabMap: Record<string, SidebarTab> = {
        '1': 'overview',
        '2': 'sessions',
        '3': 'schedules',
        '4': 'connections',
      };
      const tab = tabMap[e.key];
      if (tab && visibleTabs.includes(tab)) {
        e.preventDefault();
        setSidebarActiveTab(tab);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen, visibleTabs, setSidebarActiveTab]);

  return { visibleTabs, sidebarActiveTab, setSidebarActiveTab };
}
