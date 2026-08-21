import { useMemo, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { HOME_TABS, TOUR_ANCHORS, resolveHomeTabId } from '@/layers/shared/config';
import { BarTabStrip, type BarTab } from '@/layers/shared/ui';
import { SystemHealthDot, useSystemHealth } from '@/layers/features/top-nav';
import { OneBar } from './OneBar';

interface HomeSurfaceBarProps {
  /** Chips this surface adds, drawn to the left of the health dot. */
  chips?: ReactNode;
  /** This surface's page action, if it has one. */
  actions?: ReactNode;
}

/**
 * The one bar all four home surfaces wear: the tab strip IS the identity.
 *
 * Home, Activity, Scheduled and Workspaces used to cost two rows — a title bar
 * saying the same word the tab under it said, and the tab row itself. The tabs
 * are the identity of this surface, so they are what the bar carries; the second
 * row is gone (spec §3.4, phase H1).
 *
 * **One component for four routes, so they cannot drift.** Each route declares
 * it in `staticData.header` and passes only what is its own — the members chip
 * on Home, New Task on Scheduled. Which tab reads active is not passed at all:
 * it is resolved from the pathname on every render, so there is no per-route
 * state to keep in sync and no way for a route to light the wrong tab.
 *
 * **The health dot is the last chip, on every one of the four.** It reports the
 * whole system rather than this page, so it does not belong to Home alone — and
 * anchoring it at the right, after whatever chips a surface adds, is what keeps
 * it from sliding sideways as you move between tabs. A status light that moves
 * when you change pages is one you stop reading.
 */
export function HomeSurfaceBar({ chips, actions }: HomeSurfaceBarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const healthState = useSystemHealth();
  const tabs = useMemo<BarTab[]>(
    () => HOME_TABS.map((tab) => ({ id: tab.id, label: tab.label, to: tab.path })),
    []
  );

  return (
    <OneBar
      identity={
        <BarTabStrip
          tabs={tabs}
          activeTabId={resolveHomeTabId(pathname)}
          label="Home sections"
          indicatorLayoutId="home-tab-indicator"
          // The tour spotlights this strip, and it is one of the few things on
          // screen at every width — the sidebar it replaced in the tour is a
          // sheet on a phone, unmounted until you open it (TOUR_ANCHORS.navAgents).
          testId={TOUR_ANCHORS.homeTabs}
        />
      }
      chips={
        <>
          {chips}
          <SystemHealthDot state={healthState} />
        </>
      }
      actions={actions}
    />
  );
}
