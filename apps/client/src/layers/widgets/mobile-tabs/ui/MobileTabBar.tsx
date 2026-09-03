/**
 * The bottom bar: four destinations, one of them counted.
 *
 * **A nav, not a tablist.** Three of the four show a panel and the fourth opens
 * a conversation, and a `tablist` whose members are not all tabs is a lie a
 * screen reader repeats. This is the same shape — and the same `aria-current`
 * vocabulary — the desktop footer strip uses for the same job.
 *
 * @module widgets/mobile-tabs/ui/MobileTabBar
 */
import { cn } from '@/layers/shared/lib';
import { MOBILE_TABS, MOBILE_TAB_BAR_DOCK, type MobileTabId } from '../model/mobile-tabs';

/** Props for {@link MobileTabBar}. */
export interface MobileTabBarProps {
  /**
   * The destination the operator is looking at, or `null` when they are looking
   * at something else — a conversation opened from a row, or the routed page a
   * cold load lands on.
   *
   * Nullable on purpose. "Which tab was pressed last" is a different question,
   * and answering this one with that made the bar claim a destination the
   * operator had already left.
   */
  current: MobileTabId | null;
  /** How many things need the operator right now — the Home count (BC-11). */
  needsYouCount: number;
  /**
   * Whether DorkBot has an address to open yet.
   *
   * The roster has to answer before there is a conversation to start, and a
   * control that silently does nothing is worse than one that says it is not
   * ready — the same rule, and the same reason, as the desktop footer's glyph.
   */
  dorkBotReady: boolean;
  /** Go somewhere. */
  onSelect: (id: MobileTabId) => void;
  /**
   * The navigation landmark's accessible name. Defaults to the product's.
   *
   * Configurable because a landmark's name belongs to where it is mounted, not
   * to the component: the Dev Playground draws four of these bars on one page,
   * and four `navigation` landmarks sharing a name is an axe `landmark-unique`
   * violation — a real one, since a screen-reader user landmark-hopping that
   * page cannot tell them apart. The product mounts exactly one.
   */
  label?: string;
}

/** The bar. */
export function MobileTabBar({
  current,
  needsYouCount,
  dorkBotReady,
  onSelect,
  label = 'Main',
}: MobileTabBarProps) {
  return (
    <nav
      aria-label={label}
      data-testid="mobile-tab-bar"
      // The bar reserves its own room in the shell's column rather than
      // floating over it, so no page has to know it exists to avoid being
      // covered by it. The height is the dock the panels stop at — one string,
      // two uses.
      className="bg-sidebar border-border/60 flex shrink-0 items-stretch border-t"
      style={{ height: MOBILE_TAB_BAR_DOCK, paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {MOBILE_TABS.map((tab) => {
        const Icon = tab.icon;
        const here = tab.id === current;
        // Only a destination that may be counted is ever asked for a count, so
        // Library is badgeless by construction rather than by today's numbers.
        const badge = tab.badged && needsYouCount > 0 ? needsYouCount : null;
        // A destination that performs an act needs the thing it acts on. Only
        // DorkBot is one, and only the roster can say.
        const unavailable = tab.kind === 'action' && !dorkBotReady;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            disabled={unavailable}
            aria-current={here ? 'page' : undefined}
            data-testid={`mobile-tab-${tab.id}`}
            // Stamped by the loop, so a fifth destination is counted by the
            // browser spec whatever it ends up being called.
            data-mobile-tab=""
            className={cn(
              'focus-ring relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-[color,background-color,scale] duration-150',
              // **A tap has to answer, and on a phone there is no hover to
              // answer with.** Below 768px this bar is the whole navigation, and
              // it used to change only weight and colour — after the route
              // resolved. 0.96 rather than the row ladder's 0.98 because the
              // target is a full-height column: press scales by target size.
              //
              // The tint is what survives `prefers-reduced-motion`, which drops
              // the scale, so the tap is still acknowledged there.
              'active:bg-sidebar-accent motion-safe:active:scale-[0.96]',
              // **Weight AND contrast, because one of them was not enough and
              // the other was not real.** Measured in Chromium at 390×844: the
              // current destination came out at `oklab(0.2044 … / 0.7224)` and
              // every other one at `… / 0.6` — the same colour, 12% of alpha
              // apart, which nobody sees. Colour is never the sole indicator
              // here (spec R2), and it could not have been the indicator at
              // all: the two ends of `--sidebar-accent-foreground` and
              // `--sidebar-foreground/60` resolve to one lightness.
              here
                ? 'text-sidebar-foreground font-semibold'
                : // **`/70`, not `/60`, and the number is a measurement.** At 60%
                  // the label composites to #6b6b6b on the bar's #e8e8e8 in the
                  // light theme — 4.34:1 at 11px, under the 4.5:1 the design
                  // system requires of every label. 70% lands at #565656 (5.99:1
                  // light, 7.84:1 dark), which clears it in both. Caught by the
                  // showcase page's axe gate once the bar was drawn there, which
                  // is the same way `SidebarZone` found the same defect at `/50`.
                  'text-sidebar-foreground/70 hover:text-sidebar-foreground font-medium',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <span className="relative">
              <Icon className="size-5" aria-hidden />
              {badge !== null && (
                <span
                  data-testid={`mobile-tab-badge-${tab.id}`}
                  // Silent to a screen reader on purpose: the same count is
                  // announced, debounced and politely, by `MobileTabsLayout`'s
                  // live region — which sits OUTSIDE the panels, beside this
                  // bar. Saying it twice from two places is how a fleet of
                  // thirty agents turns a screen reader into a siren.
                  //
                  // **The region it defers to used to be the wrong one.** It
                  // was the one inside Now's zone, which lives inside a panel
                  // marked `inert` whenever it is put away — so for every
                  // moment the operator was in a conversation this number was
                  // silent and nothing else was saying it (P4.2).
                  aria-hidden
                  // Amber, the one colour this product spends on "somebody is
                  // waiting for you" (design-decisions §18).
                  //
                  // **`text-amber-950`, not `text-white`, and the number is a
                  // measurement.** White on amber-500 is 2.15:1 — a serious
                  // failure that axe reports as *incomplete* rather than as a
                  // violation, because a one-digit badge trips its "content is
                  // too short to be text" heuristic. It would have been pinned
                  // as undecided and shipped. amber-950 on amber-500 is 6.97:1,
                  // and because the pill carries its own background that holds
                  // in both themes without a variant. The panel's tinted
                  // treatment (`bg-brand/15 text-brand`) was the other
                  // candidate and measures 3.75:1 on the light bar, so it is
                  // not one.
                  className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-semibold text-amber-950 tabular-nums"
                >
                  {badge}
                </span>
              )}
            </span>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
