/**
 * The one reveal's numbers, in one place (spec `sidebar-simplification` D6).
 *
 * Separated from `SidebarZones` so the promise "reduced motion is instant" can
 * be asserted as a value rather than inferred from a rendered tree — jsdom
 * reports no geometry and runs no animation, so a test that rendered the panel
 * and found the rows present would pass whether or not the duration was zero.
 *
 * @module features/dashboard-sidebar/ui/sidebar-reveal
 */

/** How long the one reveal takes, in seconds. */
export const REVEAL_SECONDS = 0.16;

/** How far a zone travels on the way in, in pixels. A hint, not an entrance. */
export const REVEAL_RISE_PX = 4;

/**
 * The gap between one zone's reveal and the next, in seconds.
 *
 * Per ZONE and never per row: a thirty-row panel staggered by row would take
 * most of a second to finish arriving, which is the pop-in this replaces
 * wearing better clothes.
 */
export const REVEAL_STAGGER_SECONDS = 0.03;

/** The container's half of the one reveal: it owns the stagger, not the motion. */
export const REVEAL_CONTAINER = {
  hidden: {},
  shown: { transition: { staggerChildren: REVEAL_STAGGER_SECONDS } },
};

/** One zone's half: it fades and rises, and its rows do neither. */
export const REVEAL_ZONE = {
  hidden: { opacity: 0, y: REVEAL_RISE_PX },
  shown: { opacity: 1, y: 0 },
};

/**
 * How long a reveal takes for this reader.
 *
 * Zero under a reduced-motion preference — instant, not "quick" — because the
 * reveal carries no information the panel does not already carry. `null` is
 * `useReducedMotion`'s "not asked yet", which is not a preference.
 *
 * @param reducedMotion - What `useReducedMotion()` answered.
 */
export function revealTransition(reducedMotion: boolean | null): { duration: number } {
  return { duration: reducedMotion === true ? 0 : REVEAL_SECONDS };
}
