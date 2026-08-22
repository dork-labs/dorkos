import { useMemo, type ComponentType } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { HOME_TABS, TOUR_ANCHORS, resolveHomeTabId, type HomeTabId } from '@/layers/shared/config';
import { BarTabStrip, type BarTab } from '@/layers/shared/ui';
import { SystemHealthDot, useSystemHealth } from '@/layers/features/top-nav';
import { OneBar } from './OneBar';
import { HomeRoomChips } from './HomeRoomChips';
import { NewTaskAction } from './NewTaskAction';

/**
 * What each home surface adds to the shared bar.
 *
 * A table rather than four bar components, and that is load-bearing rather than
 * tidy. The shell cross-fades on the bar COMPONENT (`resolveRouteHeader`), so
 * four routes declaring four different bars — even four one-line wrappers around
 * this one — unmount the tab strip on every tab press. One component for all
 * four keeps it mounted; what differs between them lives here.
 *
 * Typed `Record<HomeTabId, …>`, so adding a home surface without deciding what
 * it puts in the bar is a compile error rather than a silently empty one.
 */
interface SurfaceExtras {
  /** State chips this surface adds, beside the tabs. */
  Chips?: ComponentType;
  /** This surface's page action. */
  Actions?: ComponentType;
}

const SURFACE_EXTRAS: Record<HomeTabId, SurfaceExtras> = {
  home: { Chips: HomeRoomChips },
  activity: {},
  scheduled: { Actions: NewTaskAction },
  workspaces: {},
};

/** A surface outside the table — nothing extra, and no `undefined` to guard. */
const NO_EXTRAS: SurfaceExtras = {};

/**
 * The one bar all four home surfaces wear: the tab strip IS the identity.
 *
 * Home, Activity, Scheduled and Workspaces used to cost two rows — a title bar
 * saying the same word the tab under it said, and the tab row itself. The tabs
 * are the identity of this surface, so they are what the bar carries; the second
 * row is gone (spec §3.4, phase H1).
 *
 * **One component, four routes, one mount.** Which tab reads active is resolved
 * from the pathname on every render, so there is no per-route state to keep in
 * sync and no way for a route to light the wrong tab — and because every home
 * route declares *this* component, the shell's cross-fade sees the same bar
 * throughout and never tears it down. That is what lets the active underline
 * slide from one tab to the next instead of blinking out with the row.
 *
 * **The health dot is the last thing before the fixed cluster, on all four.** It
 * reports the whole system rather than this page, so it does not belong to Home
 * alone; and sitting after the flexible space — behind the page action, not in
 * front of it — its distance from the right edge is the same on every surface.
 * In the chips zone it was left-anchored, which slid it 47px sideways the moment
 * Home's members chip appeared beside it. A status light that moves when you
 * change pages is one people stop reading.
 */
export function HomeSurfaceBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const healthState = useSystemHealth();
  const tabs = useMemo<BarTab[]>(
    () => HOME_TABS.map((tab) => ({ id: tab.id, label: tab.label, to: tab.path })),
    []
  );

  const activeTabId = resolveHomeTabId(pathname);
  const { Chips, Actions } = activeTabId ? SURFACE_EXTRAS[activeTabId] : NO_EXTRAS;

  return (
    <OneBar
      identity={
        <BarTabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          label="Home sections"
          indicatorLayoutId="home-tab-indicator"
          // The tour spotlights this strip, and it is one of the few things on
          // screen at every width — the sidebar it replaced in the tour is a
          // sheet on a phone, unmounted until you open it (TOUR_ANCHORS.navAgents).
          testId={TOUR_ANCHORS.homeTabs}
        />
      }
      chips={Chips ? <Chips /> : undefined}
      actions={
        <>
          {Actions ? <Actions /> : null}
          <SystemHealthDot state={healthState} />
        </>
      }
    />
  );
}
