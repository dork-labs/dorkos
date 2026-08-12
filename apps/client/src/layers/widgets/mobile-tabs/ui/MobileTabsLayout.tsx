/**
 * The cockpit on a phone: four destinations along the bottom, and no drawer.
 *
 * **Mobile is a different app, not a squeezed desktop** (spec §9, design-meta
 * rule 10). The off-canvas sheet the sidebar used to be is gone from this path
 * entirely — no hamburger, no scrim, nothing that has to be dismissed before
 * the app underneath is usable. What is left is the sidebar's brain, promoted
 * to the whole screen: Now and Today become Home, Library becomes its own calm
 * surface, DorkBot is one press away, and You holds the account.
 *
 * **One model, two panels.** `buildSidebarModel` is called once here, exactly
 * as the desktop panel calls it once, and Home and Library each draw a subset
 * of the same build. Neither tab recomputes anything, so they cannot disagree
 * about what the sidebar contains (spec §A1).
 *
 * **Panels are hidden, never unmounted, and that is the whole of AC-1.** Going
 * to Library and back must leave Home exactly where the operator left it, and
 * the only thing that genuinely loses a scroll offset is a remount: a new
 * element starts at the top. So every panel stays in the tree from the first
 * render and is put away with a style.
 *
 * The style is `visibility: hidden`, which leaves the layout box alone — not a
 * claim that `display: none` would lose the offset. **Chromium restores
 * `scrollTop` across `display: none` on the same element; that was measured at
 * 390×844 rather than assumed, and the comment this replaces asserted the
 * opposite.** `visibility` is kept because it is the engine-independent answer
 * and because a laid-out panel can still be measured, not because the other one
 * was proven broken. `inert` keeps a put-away panel out of the accessibility
 * tree and out of the tab order while it is still laid out.
 *
 * **The panels get out of the way on the navigation COMMIT, never on the URL
 * changing.** Opening a row is a request to go somewhere, and the layer has to
 * yield or the destination is behind it. The seam is the router's own
 * `onBeforeLoad`, which is what the retired `SidebarMobileNavigationClose` used
 * and for the reason it documented: re-opening the conversation you already
 * have open is the commonest tap of all — Today pins it as its first row — and
 * TanStack reports it as an unchanged href. An earlier version of this file
 * compared hrefs and so did nothing on exactly that tap, leaving a layer with
 * no way out (review B1). One subscription covers every row, present and
 * future, instead of a dismissal each new call site has to remember.
 *
 * @module widgets/mobile-tabs/ui/MobileTabsLayout
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import { cn } from '@/layers/shared/lib';
import { PageContainer } from '@/layers/shared/ui';
import {
  SidebarChrome,
  SidebarFooterStrip,
  SidebarHeaderBlock,
  SidebarZones,
  useAskDorkBot,
  useLegacyPinMigration,
  useLiveRegionText,
  useSidebarModel,
  useSidebarState,
} from '@/layers/features/dashboard-sidebar';
import { useNowApprovalsSlot } from './MobileNowApprovals';
import {
  HOME_ZONE_IDS,
  LIBRARY_ZONE_IDS,
  MOBILE_TABS,
  MOBILE_TAB_BAR_DOCK,
  type MobileTabId,
} from '../model/mobile-tabs';
import { lowerMobilePanels, useMobilePanelStore } from '../model/mobile-panel-store';
import { MobileTabBar } from './MobileTabBar';

/** Props for {@link MobileTabsLayout}. */
export interface MobileTabsLayoutProps {
  /**
   * A contributed `sidebar.body` takeover for the current route, or `null`.
   *
   * On a phone a takeover replaces **Library** and leaves Home standing (P4).
   * That is the difference from desktop, where the takeover replaces the whole
   * body: Now and Today are what needs you, and browsing the marketplace is not
   * a reason to stop being told.
   */
  takeover: ReactNode | null;
}

/**
 * One destination's panel.
 *
 * Absolutely positioned so all three stack in the same box and an inactive one
 * keeps the layout it will be shown with again.
 */
function MobileTabPanel({
  id,
  active,
  children,
}: {
  id: MobileTabId;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={`mobile-tab-panel-${id}`}
      data-testid={`mobile-tab-panel-${id}`}
      data-active={active ? '' : undefined}
      inert={!active}
      className={cn('absolute inset-0', !active && 'invisible')}
    >
      {children}
    </div>
  );
}

/**
 * The phone cockpit.
 *
 * @param props - The contributed sidebar body for this route, if any.
 */
export function MobileTabsLayout({ takeover }: MobileTabsLayoutProps) {
  // `DashboardSidebar` is never mounted at this width, so the one-time pin
  // migration has to run from here or a phone-only operator never gets it.
  useLegacyPinMigration();
  const state = useSidebarState();
  const model = useSidebarModel(state);
  const { ask: askDorkBot, ready: dorkBotReady } = useAskDorkBot();

  const [active, setActive] = useState<MobileTabId>('home');
  // Whether a panel is covering the routed page. Shared with `AppShell`, which
  // is the only component that can mark that page `inert` while it is covered.
  const panelUp = useMobilePanelStore((s) => s.panelUp);
  const raise = useMobilePanelStore((s) => s.raise);

  // **The seam is the commit, not the URL.** Subscribing rather than diffing is
  // what makes re-opening the conversation you already have open work: TanStack
  // reports that as an unchanged href, and it is the row Today pins to the top.
  // `onBeforeLoad` rather than `onBeforeNavigate` because this cockpit redirects
  // on the way into `/session`, and those landings need the layer gone too.
  //
  // It fires for navigations the operator did not start — an agent's
  // `control_ui`, the SSE session rekey. That is deliberate and inherited: the
  // app genuinely moved, so revealing where it went beats holding a layer over
  // it.
  const router = useRouter();
  useEffect(() => router.subscribe('onBeforeLoad', lowerMobilePanels), [router]);

  // The layout is unmounted when the window grows to desktop width. Leaving the
  // bit raised would mean a phone that came back mid-session opened covered,
  // which is the cold-load state this deliberately does not have.
  useEffect(() => lowerMobilePanels, []);

  // **Say how much of the bottom edge is spoken for, so nothing has to guess.**
  // Anything that docks to the bottom of the screen has to clear the bar, and
  // the things that do are `fixed` overlays in other layers — the PIP mini-bar
  // is a `features/` component, which cannot import this widget's constant even
  // though it must not paint over it (DOR-1177). So the number is published as
  // a custom property while the bar is on screen and removed with it, the same
  // shape `PipMiniBar` uses for `--pip-dock` in the other direction. Readers
  // default to `0px`, which is the truth on desktop and in the Obsidian embed,
  // where this cockpit is never mounted.
  useEffect(() => {
    document.documentElement.style.setProperty('--mobile-tab-dock', MOBILE_TAB_BAR_DOCK);
    return () => {
      document.documentElement.style.removeProperty('--mobile-tab-dock');
    };
  }, []);

  const onSelect = useCallback(
    (id: MobileTabId) => {
      const tab = MOBILE_TABS.find((entry) => entry.id === id);
      if (tab === undefined) return;
      if (tab.kind === 'action') {
        // DorkBot has no panel: pressing it opens a conversation, and the
        // conversation is the thing you asked for — so nothing is raised, and
        // the router subscription above lowers whatever was up. Until the
        // roster answers there is no DorkBot to open, and a press that quietly
        // did nothing would be worse than a control that says it is not ready
        // (the bar disables it; this is the same rule at the seam that acts).
        if (!dorkBotReady) return;
        setActive(id);
        askDorkBot();
        return;
      }
      setActive(id);
      raise();
    },
    [askDorkBot, dorkBotReady, raise]
  );

  // The count BC-11 announces, read off the model rather than counted again
  // here: Now also holds the "N working" rollup, and a badge that counted rows
  // would tell a quiet morning that one agent needs it (P4 AC-2).
  const nowZone = model.zones.find((zone) => zone.id === 'now');
  const needsYouCount = nowZone?.needsYouCount ?? 0;
  // **The badge's words, said from outside the panels.** The badge itself is
  // `aria-hidden` on the grounds that the count is already announced — and it
  // is, by the region inside Now's zone, which lives inside a panel that is
  // `inert` whenever it is put away. That is every moment the operator is in a
  // conversation, which is when an agent starts needing them. So the phone's
  // announcement moved out here, beside the bar that never leaves the screen,
  // and the zone stands its own region down (`silenceLiveRegion`) rather than
  // both of them saying the same number.
  const liveRegionText = useLiveRegionText(nowZone?.liveRegionText);

  // Approve from anywhere (P4 AC-5). `null` when there is nothing waiting AND
  // nothing has failed — which is also what tells `SidebarZones` not to draw a
  // Now zone for it.
  const nowApprovals = useNowApprovalsSlot();

  return (
    <SidebarChrome activeTarget={state.activeTarget}>
      <div
        data-testid="mobile-tab-panels"
        // Fixed to the shell rather than in the column, so the panels cover the
        // routed content instead of squeezing it, and stop exactly where the
        // bar starts.
        //
        // Put away with `visibility` for the same reason an inactive panel is:
        // it stays mounted, so coming back to Home from a conversation lands
        // where you left it.
        inert={!panelUp}
        className={cn(
          'bg-background fixed inset-x-0 top-0 z-30',
          !panelUp && 'pointer-events-none invisible'
        )}
        // The panels stop where the bar starts — and, when a PIP is docked, one
        // mini-bar higher: the bar is a `fixed` overlay above these panels, so
        // without this the last row of Today sits under it and cannot be
        // pressed (DOR-1177). `--pip-dock` is absent whenever no PIP is
        // minimized, which is what makes the ordinary case cost nothing.
        style={{ bottom: `calc(${MOBILE_TAB_BAR_DOCK} + var(--pip-dock, 0px))` }}
      >
        <MobileTabPanel id="home" active={active === 'home'}>
          {/* New stays in the header — no FAB (§9). The header block is the
              whole of it: whose cockpit this is, one New button, one search
              pill (BC-43 → BC-46). */}
          <PageContainer width="full" className="px-3 py-2">
            <SidebarHeaderBlock />
            <SidebarZones
              model={model}
              zoneIds={HOME_ZONE_IDS}
              nowSlot={nowApprovals}
              silenceLiveRegion
            />
          </PageContainer>
        </MobileTabPanel>

        <MobileTabPanel id="library" active={active === 'library'}>
          <PageContainer width="full" className="px-3 py-2">
            {/* A contributed body takes over Library and nothing else here. */}
            {/* Silenced for the same reason Home is: this cockpit announces
                Now's count once, from beside the bar. Library carries no count
                today, and this is what keeps that true if it ever does. */}
            {takeover ?? (
              <SidebarZones model={model} zoneIds={LIBRARY_ZONE_IDS} silenceLiveRegion />
            )}
          </PageContainer>
        </MobileTabPanel>

        <MobileTabPanel id="you" active={active === 'you'}>
          <PageContainer width="full" className="px-3 py-4">
            <h1 className="text-foreground px-2 pb-2 text-sm font-semibold">You</h1>
            {/* The same strip the desktop panel's footer carries, and the same
                one implementation of the four places DorkOS goes — including
                the `nav-agents` anchor, which would otherwise exist only at
                desktop width. A phone has room for it as a row of its own. */}
            <SidebarFooterStrip />
          </PageContainer>
        </MobileTabPanel>
      </div>

      {/* **`current` is what is on screen, not what was last pressed.** With a
          panel down the operator is looking at a conversation, which is not one
          of the four destinations, so none of them is current — saying
          otherwise made the bar lie twice in review: DorkBot stayed marked
          after Back, and Library stayed marked with every panel hidden. */}
      {/* Outside the panels, so it is never `inert`. Count changes only, held
          for a second, exactly as the zone's own region holds them (BC-11). */}
      <span
        data-testid="mobile-needs-you-live-region"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveRegionText}
      </span>

      <MobileTabBar
        current={panelUp ? active : null}
        needsYouCount={needsYouCount}
        dorkBotReady={dorkBotReady}
        onSelect={onSelect}
      />
    </SidebarChrome>
  );
}
