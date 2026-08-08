/**
 * Whether the roster's cards may travel when the grid re-orders.
 *
 * @module features/team-roster/lib/roster-layout
 */

/**
 * Above this many cards, layout animation stops being calm and starts being a
 * wave.
 *
 * 120 is where a three-column grid stops fitting a couple of screens, so it is
 * also where "the cards I can see moved" turns into "something is happening
 * off-screen". `layout` measures and transforms every card on every commit; the
 * cost is linear in cards and the *legibility* falls off long before the frame
 * budget does, which is why the bound is a count rather than a benchmark.
 */
export const ROSTER_LAYOUT_LIMIT = 120;

/** What the roster's layout-animation gate is decided from. */
export interface RosterLayoutInput {
  /** How many cards the grid is about to draw. */
  memberCount: number;
  /** Whether this person asked for less motion. */
  reducedMotion: boolean;
}

/**
 * Should the roster animate its cards into their new positions?
 *
 * Two gates, and they are AND rather than a tiebreak.
 *
 * **Reduced motion is a hard off, not a shortening.** `motion/react` writes
 * inline styles from JS, so the global `prefers-reduced-motion` reset in
 * `index.css` — which collapses every CSS transition and animation duration —
 * never touches it. Nothing else in the app would stop a spring, and a card
 * teleporting 400px in 10ms is worse than a card that does not move.
 *
 * **The size gate is about calm, not correctness.** Nothing breaks past
 * {@link ROSTER_LAYOUT_LIMIT}; it just stops reading as "these cards moved".
 *
 * Extracted as a function so it can be tested at full strength: `test-setup.ts`
 * strips every motion prop before it reaches the DOM, so `layout` and
 * `layoutId` are unassertable in jsdom. The grid reports this same boolean as
 * `data-layout-animated`, and because one value drives both, the attribute
 * cannot drift from the behaviour it stands for.
 *
 * @param input - The card count and the motion preference.
 */
export function shouldAnimateRoster({ memberCount, reducedMotion }: RosterLayoutInput): boolean {
  return !reducedMotion && memberCount <= ROSTER_LAYOUT_LIMIT;
}
