import { Fragment, useCallback, useEffect, useRef } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { revealInScroller, useScrollOverflow } from '@/layers/shared/model';

const INDICATOR_SPRING = { type: 'spring', stiffness: 500, damping: 32 } as const;

/** One tab of a {@link BarTabStrip}: what it says and where it goes. */
export interface BarTab {
  /** Stable id, used for the active comparison and the React key. */
  id: string;
  /** What the tab says. */
  label: string;
  /** The route it navigates to. */
  to: LinkProps['to'];
  /** Search params to carry or rewrite — how `/team`'s views spell `?view=`. */
  search?: LinkProps['search'];
  /**
   * Draw a hairline immediately before this tab, splitting the strip into
   * groups — `/team`'s three ways of reading the roster, then its two rules
   * surfaces. A property of the tab the group STARTS with rather than a
   * separate entry in the list, so a group cannot be reordered away from its
   * own divider and no divider can outlive the tab it introduces.
   */
  dividerBefore?: boolean;
}

interface BarTabStripProps {
  /** The tabs, in strip order. */
  tabs: readonly BarTab[];
  /** Which tab reads active, or `null` when none does. */
  activeTabId: string | null;
  /** Accessible name for the strip's `nav` landmark ("Home sections"). */
  label: string;
  /**
   * Shared layout id for the sliding active marker. Two strips on screen at
   * once with the same id would animate the marker between them, so give each
   * strip its own.
   */
  indicatorLayoutId: string;
  /**
   * `data-testid` for the scroller. The edge fades derive theirs from it
   * (`<testId>-fade-start` / `-fade-end`), so a strip that is targeted at all is
   * targeted consistently.
   */
  testId?: string;
  /** Extra classes for the positioning wrapper. */
  className?: string;
}

/**
 * Links dressed as tabs, in a strip that scrolls sideways and says so.
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
 * driven by the `activeTabId` its caller resolves. Tests assert on `data-active`,
 * so a broken resolver cannot hide behind `Link`.
 *
 * **The strip scrolls sideways, and says so** (DOR-1180). Four labels do not fit
 * a phone: measured in Chromium at 390×844, the home strip wants 430px and has
 * 390, so a cold load opened on `Home | Activity | Scheduled | Workspac` — a
 * cut-off word being the first thing a phone user ever saw. Sideways scrolling
 * was always the design (it is what keeps working when a fifth tab arrives) and
 * the page never scrolled with it, so the bug was never the overflow: it was
 * that nothing on screen said the strip had more, and macOS draws no scrollbar
 * until you have already scrolled. Shrinking the labels to fit was rejected — it
 * buys one phone width in one font and loses the strip the day a fifth tab or a
 * longer word arrives, and it makes "does it fit" a property of the device.
 *
 * So the strip wears the affordance the right panel's tab strip already wears: a
 * fade over whichever edge still has tabs behind it, and never over an edge that
 * does not (ADR 260725-004456 — a cue over content that cannot be reached is
 * worse than no cue). At a width where everything fits, nothing is drawn at all.
 *
 * **And the active tab is always brought into view.** A deep link or a bookmark
 * to `/workspaces` lands on the one tab that starts off-screen, and a strip whose
 * active marker is behind an edge answers "which part of Home am I in?" with
 * nothing.
 */
export function BarTabStrip({
  tabs,
  activeTabId,
  label,
  indicatorLayoutId,
  testId,
  className,
}: BarTabStripProps) {
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
    // In the bar the strip is IDENTITY, so it takes the width its labels need
    // and no more (`flex-initial`: size to content, shrink when the row runs
    // out). Growing to fill the bar — which it did while nothing sat beside it —
    // left the chips that belong next to the tabs floating in the middle of an
    // empty row, and it made the strip start scrolling while there was still
    // free space to its right, because a `flex-1` strip and the bar's `flex-1`
    // spacer split the slack between them instead of giving it to the tabs.
    // `min-w-0` is what still lets it shrink and scroll on a phone.
    <div
      className={cn(
        'relative',
        // `self-stretch` is what makes the tabs a real target. The bar centres
        // its children, so without it this wrapper is only as tall as one line
        // of text — the `h-full` on each tab then resolved against a 24px box,
        // and every tab in the strip was a 24px tap target inside a 36px row
        // (measured in Chromium at 1440, DOR-1401). Stretched, `h-full` means
        // the row: 35px of pressable height, the 36px header less the 1px of it
        // that is the bottom hairline. The active underline lands on that
        // baseline too, instead of floating above it.
        //
        // The shell's cross-fade wrapper has to stretch as well, or this one has
        // nothing taller to stretch to (`AppShell.tsx`).
        //
        // **A floor, not `min-w-0`.** `flex-initial` yields space to everything
        // beside it, and with nothing to stop it the strip yields all of it: on
        // a 768px window with the sidebar and the right panel both docked, the
        // four home tabs measured 16px wide — no label, and not even the fade
        // that says there is more. `min-w-28` is one full tab plus its fade, so
        // the strip still shrinks and still scrolls sideways on a phone, and
        // stops at the width where it is still a strip.
        'flex min-w-28 flex-initial self-stretch',
        className
      )}
    >
      <nav
        ref={scrollerRef}
        onScroll={edges.onScroll}
        aria-label={label}
        data-slot="bar-tab-strip"
        data-testid={testId}
        className={cn(
          'flex items-stretch gap-1 overflow-x-auto',
          // The native scrollbar is hidden by `data-slot` in `index.css` — the
          // edge fades below are this strip's affordance, and a reserved
          // scrollbar was eating 11px of its own tap target. It cannot be a
          // utility class here: the global `* { scrollbar-width: thin }` it has
          // to beat is unlayered, so it outranks anything in `utilities`.
          'min-w-0 flex-1'
        )}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <Fragment key={tab.id}>
              {tab.dividerBefore && (
                // Inset from the row's top and bottom so it reads as a group
                // break rather than a second hairline competing with the bar's
                // own. `aria-hidden`: the grouping is visual, and a screen
                // reader announcing a separator between two links in a
                // four-link region would be noise, not structure.
                <div
                  aria-hidden
                  data-slot="bar-tab-strip-divider"
                  className="bg-border my-2 w-px shrink-0 self-stretch"
                />
              )}
              <Link
                ref={isActive ? activeRef : undefined}
                to={tab.to}
                search={tab.search}
                data-active={isActive || undefined}
                className={cn(
                  'relative flex shrink-0 items-center text-sm font-medium whitespace-nowrap transition-colors',
                  // Two densities, two targets. A standalone row gets `min-h-11`
                  // — the 44px touch target — relaxing to 36px on a desktop. In
                  // the bar there is no such room: `h-full` fills the shell's row,
                  // which measures 35px (the wrapper's `self-stretch` is what
                  // makes "full" mean the row rather than one line of text).
                  // That is under the 44px touch guidance, and it is the trade the
                  // One Bar makes on a phone — one 36px row instead of two rows
                  // totalling 80px. Flagged at the spec's phone checkpoint, not
                  // silently absorbed.
                  'h-full px-2.5',
                  // An INSET ring, not the shared `focus-ring` box-shadow. Setting
                  // `overflow-x: auto` computes `overflow-y` to `auto` as well, and
                  // this nav's content box is exactly one tab tall — so a ring drawn
                  // outside the tab's border box falls outside the scroll container
                  // and is clipped top and bottom. A ring painted inside the border
                  // box has nothing to clip against, and the tab's full-height
                  // target survives (padding on the nav would have had to grow the
                  // row to keep it).
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
                    data-slot="bar-tab-strip-indicator"
                    layoutId={indicatorLayoutId}
                    className="bg-primary absolute right-0 bottom-0 left-0 h-0.5"
                    transition={INDICATOR_SPRING}
                  />
                )}
              </Link>
            </Fragment>
          );
        })}
      </nav>
      {/* Decorative, and never in the way of the tab underneath: the fade covers
          the full height of the row it sits over, so anything that swallowed a
          tap would cost more than the cue is worth. */}
      {edges.start && (
        <div
          aria-hidden
          data-testid={testId && `${testId}-fade-start`}
          className="from-background via-background/70 pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r to-transparent"
        />
      )}
      {edges.end && (
        <div
          aria-hidden
          data-testid={testId && `${testId}-fade-end`}
          className="from-background via-background/70 pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent"
        />
      )}
    </div>
  );
}
