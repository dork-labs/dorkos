import { useMemo } from 'react';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { BarTabStrip, type BarTab } from '@/layers/shared/ui';
import { HOME_TABS, type HomeTabId } from '../lib/home-tabs';

interface HomeTabBarProps {
  /** The tab that reads active, or `null` when none of them does. */
  activeTabId: HomeTabId | null;
}

/**
 * The home surface's tab bar: Home, Activity, Scheduled, Workspaces.
 *
 * All the mechanics — links-as-tabs, the sideways scroll with edge fades, the
 * active tab brought into view — live in {@link BarTabStrip} now, which the
 * `/team` views will wear too. This is what is left once they are shared: which
 * tabs, what the strip is called, and the tour anchor.
 *
 * It still renders as its own row under the header. Phase H1 moves these tabs
 * into the bar itself, and this row goes away with them.
 *
 * @param props - The active tab id.
 */
export function HomeTabBar({ activeTabId }: HomeTabBarProps) {
  const tabs = useMemo<BarTab[]>(
    () => HOME_TABS.map((tab) => ({ id: tab.id, label: tab.label, to: tab.path })),
    []
  );

  return (
    <BarTabStrip
      tabs={tabs}
      activeTabId={activeTabId}
      label="Home sections"
      indicatorLayoutId="home-tab-indicator"
      density="row"
      // The tour spotlights this bar, and it is one of the few things on screen
      // at every width — the sidebar it replaced in the tour is a sheet on a
      // phone, unmounted until you open it (see TOUR_ANCHORS.navAgents).
      testId={TOUR_ANCHORS.homeTabs}
    />
  );
}
