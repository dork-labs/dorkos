import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { cn } from '@/layers/shared/lib';
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
 * The bar scrolls sideways rather than wrapping or shrinking: four labels fit a
 * phone today, and a bar that scrolls keeps fitting when a fifth arrives.
 *
 * @param props - The active tab id.
 */
export function HomeTabBar({ activeTabId }: HomeTabBarProps) {
  return (
    <nav
      aria-label="Home sections"
      data-slot="home-tab-bar"
      // The tour spotlights this bar, and it is one of the few things on screen
      // at every width — the sidebar it replaced in the tour is a sheet on a
      // phone, unmounted until you open it (see TOUR_ANCHORS.navAgents).
      data-testid={TOUR_ANCHORS.homeTabs}
      className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b px-2"
    >
      {HOME_TABS.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <Link
            key={tab.id}
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
  );
}
