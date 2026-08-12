import { useCallback, useEffect, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { cn } from '@/layers/shared/lib';
import { revealInScroller, useScrollOverflow } from '@/layers/shared/model';
import { HOME_TABS, type HomeTabId } from '../lib/home-tabs';

const INDICATOR_SPRING = { type: 'spring', stiffness: 500, damping: 32 } as const;

interface HomeTabBarProps {
  /** The tab that reads active, or `null` when none of them does. */
  activeTabId: HomeTabId | null;
}

/**
 * The home surface's tab bar: Home, Activity, Scheduled, Workspaces.
 *
 * **These are links, not ARIA tabs.** Each one changes the URL, so it is
 * navigation wearing a tab bar's clothes: an anchor a person can middle-click,
 * copy, or open in a new window, and a screen reader announces as a link inside
 * a named region. `role="tablist"` would promise a panel that swaps in place and
 * would put a second tablist inside the desktop shell's window-tab strip, which
 * already owns that role for the whole main region.
 *
 * **`aria-current="page"` comes from `Link` itself.** It computes its own active
 * state and its value wins over anything passed in, so this component does not
 * set it — and nothing should read it as evidence about the code here. What this
 * component owns is the *visible* state: `data-active` and the indicator, both
 * driven by `resolveHomeTabId` through `activeTabId`. The tests assert on
 * `data-active`, so a broken resolver cannot hide behind `Link`.
 *
 * **The bar scrolls sideways, and says so** (DOR-1180). Four labels do not fit a
 * phone: measured in Chromium at 390×844, the strip wants 430px and has 390, so
 * a cold load opened on `Home | Activity | Scheduled | Workspac` — a cut-off
 * word being the first thing a phone user ever saw. Sideways scrolling was
 * always the design (it is what keeps working when a fifth tab arrives) and the
 * page never scrolled with it, so the bug was never the overflow: it was that
 * nothing on screen said the bar had more, and macOS draws no scrollbar until
 * you have already scrolled. Shrinking the labels to fit was rejected — it buys
 * one phone width in one font and loses the tab bar the day a fifth tab or a
 * longer word arrives, and it makes "does it fit" a property of the device.
 *
 * So the bar wears the affordance the right panel's tab strip already wears: a
 * fade over whichever edge still has tabs behind it, and never over an edge that
 * does not (ADR 260725-004456 — a cue over content that cannot be reached is
 * worse than no cue). At a width where all four fit, nothing is drawn at all.
 *
 * **And the active tab is always brought into view.** A deep link or a bookmark
 * to `/workspaces` lands on the one tab that starts off-screen, and a bar whose
 * active marker is behind an edge answers "which part of Home am I in?" with
 * nothing.
 *
 * @param props - The active tab id.
 */
export function HomeTabBar({ activeTabId }: HomeTabBarProps) {
  const scrollerRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  const edges = useScrollOverflow(scrollerRef, 'horizontal');

  // Reveal on mount and on every change of which tab is active. A click reveals
  // its own tab for free (the browser scrolls what it focuses), so this is for
  // everything else: a cold load on a deep link, the back button, a command
  // palette entry, an agent's `control_ui`.
  const revealActiveTab = useCallback(() => {
    const scroller = scrollerRef.current;
    const tab = activeRef.current;
    if (!scroller || !tab) return;
    revealInScroller(scroller, tab);
  }, []);

  // **And again whenever the boxes move.** The app loads its type
  // asynchronously, so every label is one width in the fallback face and
  // another once the real one lands — a scroll position that revealed the last
  // tab in the first face leaves it short of the edge in the second. Rotating
  // the phone does the same thing to the strip. Both are resizes, and neither
  // is a render.
  useEffect(() => {
    revealActiveTab();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(revealActiveTab);
    for (const el of [scrollerRef.current, activeRef.current]) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [revealActiveTab, activeTabId]);

  return (
    // The wrapper is the positioning context for the fades, which have to be
    // pinned to what the strip SHOWS rather than to what it holds — absolutely
    // positioning them inside the scroller would park them at the scrolled
    // content's edges and scroll them away with it.
    <div className="relative shrink-0 border-b">
      <nav
        ref={scrollerRef}
        onScroll={edges.onScroll}
        aria-label="Home sections"
        data-slot="home-tab-bar"
        // The tour spotlights this bar, and it is one of the few things on screen
        // at every width — the sidebar it replaced in the tour is a sheet on a
        // phone, unmounted until you open it (see TOUR_ANCHORS.navAgents).
        data-testid={TOUR_ANCHORS.homeTabs}
        className="flex items-stretch gap-1 overflow-x-auto px-2"
      >
        {HOME_TABS.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <Link
              key={tab.id}
              ref={isActive ? activeRef : undefined}
              to={tab.path}
              data-active={isActive || undefined}
              className={cn(
                // `min-h-11` is the 44px touch target on a phone; the desktop bar
                // relaxes to the shell's denser rhythm.
                'relative flex min-h-11 shrink-0 items-center px-3 text-sm font-medium whitespace-nowrap transition-colors md:min-h-9',
                // An INSET ring, not the shared `focus-ring` box-shadow. Setting
                // `overflow-x: auto` computes `overflow-y` to `auto` as well, and
                // this nav's content box is exactly one tab tall — so a ring drawn
                // outside the tab's border box falls outside the scroll container
                // and is clipped top and bottom. A ring painted inside the border
                // box has nothing to clip against, and the 44px target survives
                // (padding on the nav would have had to grow the row to keep it).
                'focus-visible:ring-ring outline-hidden focus-visible:ring-2 focus-visible:ring-inset',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {tab.label}
              {isActive && (
                // Reduced motion is handled once, app-wide: the shell wraps
                // everything in `<MotionConfig reducedMotion="user">`
                // (AppShell.tsx), which drops this slide for anyone who asked for
                // less motion.
                <motion.span
                  data-slot="home-tab-indicator"
                  layoutId="home-tab-indicator"
                  className="bg-primary absolute right-0 bottom-0 left-0 h-0.5"
                  transition={INDICATOR_SPRING}
                />
              )}
            </Link>
          );
        })}
      </nav>
      {/* Decorative, and never in the way of the tab underneath: the fade sits
          over a 44px touch target, so anything that swallowed a tap would cost
          more than the cue is worth. Stops short of the bottom hairline
          (`bottom-px`) so the border reads as one unbroken line under it. */}
      {edges.start && (
        <div
          aria-hidden
          data-testid="home-tabs-fade-start"
          className="from-background via-background/70 pointer-events-none absolute top-0 bottom-px left-0 w-8 bg-gradient-to-r to-transparent"
        />
      )}
      {edges.end && (
        <div
          aria-hidden
          data-testid="home-tabs-fade-end"
          className="from-background via-background/70 pointer-events-none absolute top-0 right-0 bottom-px w-8 bg-gradient-to-l to-transparent"
        />
      )}
    </div>
  );
}
