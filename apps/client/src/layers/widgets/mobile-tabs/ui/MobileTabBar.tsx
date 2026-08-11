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
  /** Which destination is current. */
  active: MobileTabId;
  /** How many things need the operator right now — the Home count (BC-11). */
  needsYouCount: number;
  /** Go somewhere. */
  onSelect: (id: MobileTabId) => void;
}

/** The bar. */
export function MobileTabBar({ active, needsYouCount, onSelect }: MobileTabBarProps) {
  return (
    <nav
      aria-label="Main"
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
        const current = tab.id === active;
        // Only a destination that may be counted is ever asked for a count, so
        // Library is badgeless by construction rather than by today's numbers.
        const badge = tab.badged && needsYouCount > 0 ? needsYouCount : null;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            aria-current={current ? 'page' : undefined}
            data-testid={`mobile-tab-${tab.id}`}
            // Stamped by the loop, so a fifth destination is counted by the
            // browser spec whatever it ends up being called.
            data-mobile-tab=""
            className={cn(
              'focus-ring relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors duration-150',
              current
                ? 'text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/60 hover:text-sidebar-foreground'
            )}
          >
            <span className="relative">
              <Icon className="size-5" aria-hidden />
              {badge !== null && (
                <span
                  data-testid={`mobile-tab-badge-${tab.id}`}
                  // Silent to a screen reader on purpose: the same count is
                  // already announced, debounced and politely, by the live
                  // region inside the Home panel's Now zone (BC-11). Saying it
                  // twice from two places is how a fleet of thirty agents turns
                  // a screen reader into a siren.
                  aria-hidden
                  // Amber, the one colour this product spends on "somebody is
                  // waiting for you" — the same weight the directed-unread
                  // badge carries in the panel (design-decisions §18).
                  className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums"
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
