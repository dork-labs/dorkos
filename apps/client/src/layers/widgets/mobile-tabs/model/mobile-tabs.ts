/**
 * What the bottom bar offers, as data.
 *
 * The list IS the bar: the renderer maps it and decides nothing, so "how many
 * destinations are there, and which one carries a count?" is answerable by
 * reading three lines instead of a component.
 *
 * @module widgets/mobile-tabs/model/mobile-tabs
 */
import { LayoutDashboard, Sparkles, UserRound } from 'lucide-react';

/** One destination in the bottom bar. */
export interface MobileTabDescriptor {
  /** Stable id — also the panel's DOM id and the bar button's test handle. */
  id: 'home' | 'dorkbot' | 'you';
  /** The word under the glyph, and the button's accessible name. */
  label: string;
  /** The glyph. */
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Whether this destination may ever draw a count.
   *
   * **Structural, so "only Home carries a badge" cannot decay into a
   * coincidence** (P4 AC-2). The bar renders a badge only where this is `true`,
   * so no future state can put one on another destination — it would have to
   * be turned on here, deliberately, in a diff a reviewer sees.
   */
  badged: boolean;
  /**
   * Whether pressing it opens a panel or performs an act.
   *
   * DorkBot is the one destination with nothing to show: pressing it opens a
   * fresh conversation, which is a route, so the bar hands you the destination
   * rather than a panel about it.
   */
  kind: 'panel' | 'action';
}

/**
 * The three destinations, in the order they are drawn.
 *
 * **Home is the whole sidebar**, the same list the desktop panel draws — the
 * doors to Threads and the Directory, your sections, Channels and Direct
 * messages — with what is waiting on you answered at its top. The sidebar is
 * one list now, so there is nothing left to split across a second tab.
 */
export const MOBILE_TABS: readonly MobileTabDescriptor[] = [
  { id: 'home', label: 'Home', icon: LayoutDashboard, badged: true, kind: 'panel' },
  { id: 'dorkbot', label: 'DorkBot', icon: Sparkles, badged: false, kind: 'action' },
  { id: 'you', label: 'You', icon: UserRound, badged: false, kind: 'panel' },
];

/** One destination's id. */
export type MobileTabId = MobileTabDescriptor['id'];

/**
 * How tall the bar is, as one string used in two places.
 *
 * The bar reserves exactly this much room at the bottom of the shell and the
 * panels stop exactly this far up, so nothing can overlap it. Two literals here
 * would be two chances for a phone with a home indicator to hide the last row
 * of the list behind the bar, which is why `mobile-tabs.test.tsx` asserts the two
 * are the same string rather than that each is plausible.
 */
export const MOBILE_TAB_BAR_DOCK = 'calc(3.5rem + env(safe-area-inset-bottom))';
