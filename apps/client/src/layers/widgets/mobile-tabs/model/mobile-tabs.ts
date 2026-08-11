/**
 * What the bottom bar offers, as data.
 *
 * The list IS the bar: the renderer maps it and decides nothing, so "how many
 * destinations are there, and which one carries a count?" is answerable by
 * reading four lines instead of a component.
 *
 * @module widgets/mobile-tabs/model/mobile-tabs
 */
import { Hash, LayoutDashboard, Sparkles, UserRound } from 'lucide-react';
import { SIDEBAR_ZONE_IDS, type SidebarZoneId } from '@/layers/features/dashboard-sidebar';

/** One destination in the bottom bar. */
export interface MobileTabDescriptor {
  /** Stable id — also the panel's DOM id and the bar button's test handle. */
  id: 'home' | 'library' | 'dorkbot' | 'you';
  /** The word under the glyph, and the button's accessible name. */
  label: string;
  /** The glyph. */
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Whether this destination may ever draw a count.
   *
   * **Structural, so "Library carries no badge under any state" cannot decay
   * into a coincidence** (P4 AC-2). The bar renders a badge only where this is
   * `true`, so no future state of the model can put one on the calm surface —
   * it would have to be turned on here, deliberately, in a diff a reviewer sees.
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
 * The four destinations, in the order the mockup draws them.
 *
 * Home is badged and Library deliberately is not: Library is the calm surface,
 * the one place in the app that never asks for anything (§9).
 */
export const MOBILE_TABS: readonly MobileTabDescriptor[] = [
  { id: 'home', label: 'Home', icon: LayoutDashboard, badged: true, kind: 'panel' },
  { id: 'library', label: 'Library', icon: Hash, badged: false, kind: 'panel' },
  { id: 'dorkbot', label: 'DorkBot', icon: Sparkles, badged: false, kind: 'action' },
  { id: 'you', label: 'You', icon: UserRound, badged: false, kind: 'panel' },
];

/** One destination's id. */
export type MobileTabId = MobileTabDescriptor['id'];

/**
 * The zones Library's tab draws. Library, and only Library.
 *
 * Written as the filter's complement rather than as `['library']` so that this
 * constant and {@link HOME_ZONE_IDS} cannot drift into overlapping or into
 * dropping a zone between them — the two together are exactly
 * {@link SIDEBAR_ZONE_IDS}, which is the property `mobile-tabs.test.tsx` pins.
 */
export const LIBRARY_ZONE_IDS: readonly SidebarZoneId[] = SIDEBAR_ZONE_IDS.filter(
  (id) => id === 'library'
);

/**
 * The zones Home's tab draws: everything that is not Library.
 *
 * Derived from the model's own enumeration, so a fifth computed zone lands in
 * Home the day it is added instead of silently rendering nowhere on a phone.
 */
export const HOME_ZONE_IDS: readonly SidebarZoneId[] = SIDEBAR_ZONE_IDS.filter(
  (id) => id !== 'library'
);

/**
 * How tall the bar is, as one string used in two places.
 *
 * The bar reserves exactly this much room at the bottom of the shell and the
 * panels stop exactly this far up, so nothing can overlap it. Two literals here
 * would be two chances for a phone with a home indicator to hide the last row
 * of Today behind the bar, which is why `mobile-tabs.test.tsx` asserts the two
 * are the same string rather than that each is plausible.
 */
export const MOBILE_TAB_BAR_DOCK = 'calc(3.5rem + env(safe-area-inset-bottom))';
