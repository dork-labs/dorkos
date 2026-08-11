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
 * @module widgets/mobile-tabs/ui/MobileTabsLayout
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { cn } from '@/layers/shared/lib';
import { PageContainer } from '@/layers/shared/ui';
import {
  SidebarChrome,
  SidebarFooterStrip,
  SidebarHeaderBlock,
  SidebarZones,
  useAskDorkBot,
  useLegacyPinMigration,
  useSidebarModel,
  useSidebarState,
} from '@/layers/features/dashboard-sidebar';
import {
  HOME_ZONE_IDS,
  LIBRARY_ZONE_IDS,
  MOBILE_TABS,
  MOBILE_TAB_BAR_DOCK,
  type MobileTabId,
} from '../model/mobile-tabs';
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
  const { ask: askDorkBot } = useAskDorkBot();

  const [active, setActive] = useState<MobileTabId>('home');
  // Whether a panel is covering the destination the operator opened. There is
  // no drawer to close and nothing modal here: pressing a row in Home is a
  // request to go somewhere, and this is the layout getting out of the way of
  // where you went. The bar and every panel stay mounted, scroll and all.
  const [panelUp, setPanelUp] = useState(true);

  // **Adjusted during render, not in an effect.** React's own pattern for "reset
  // some state when a value changes" (react.dev, "You Might Not Need an
  // Effect"): an effect would paint the panel over the destination for one frame
  // first, which is exactly the flash the drawer used to have.
  const href = useRouterState({ select: (s) => s.location.href });
  const [lastHref, setLastHref] = useState(href);
  if (lastHref !== href) {
    setLastHref(href);
    setPanelUp(false);
  }

  const onSelect = useCallback(
    (id: MobileTabId) => {
      const tab = MOBILE_TABS.find((entry) => entry.id === id);
      if (tab === undefined) return;
      setActive(id);
      if (tab.kind === 'action') {
        // DorkBot has no panel: pressing it opens a conversation, and the
        // conversation is the thing you asked for.
        setPanelUp(false);
        askDorkBot();
        return;
      }
      setPanelUp(true);
    },
    [askDorkBot]
  );

  // The count BC-11 announces, read off the model rather than counted again
  // here: Now also holds the "N working" rollup, and a badge that counted rows
  // would tell a quiet morning that one agent needs it (P4 AC-2).
  const needsYouCount = model.zones.find((zone) => zone.id === 'now')?.needsYouCount ?? 0;

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
        style={{ bottom: MOBILE_TAB_BAR_DOCK }}
      >
        <MobileTabPanel id="home" active={active === 'home'}>
          {/* New stays in the header — no FAB (§9). The header block is the
              whole of it: whose cockpit this is, one New button, one search
              pill (BC-43 → BC-46). */}
          <PageContainer width="full" className="px-3 py-2">
            <SidebarHeaderBlock />
            <SidebarZones model={model} zoneIds={HOME_ZONE_IDS} />
          </PageContainer>
        </MobileTabPanel>

        <MobileTabPanel id="library" active={active === 'library'}>
          <PageContainer width="full" className="px-3 py-2">
            {/* A contributed body takes over Library and nothing else here. */}
            {takeover ?? <SidebarZones model={model} zoneIds={LIBRARY_ZONE_IDS} />}
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

      <MobileTabBar active={active} needsYouCount={needsYouCount} onSelect={onSelect} />
    </SidebarChrome>
  );
}
