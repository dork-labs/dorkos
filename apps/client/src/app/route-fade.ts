/**
 * Whether the routed page may cross-fade in on navigation (DOR-1764), and
 * which page the fade is keyed on (DOR-2616).
 *
 * @module app/route-fade
 */

/**
 * Should the page fade in when the route changes?
 *
 * Pure, so the rule is unit-testable at full strength — `test-setup.ts` strips
 * `initial`/`animate`/`transition` from every `motion.*` component, so no
 * motion prop is assertable in jsdom. {@link AppShell} stamps this same
 * boolean as `data-route-fade` on the routed wrapper, so a browser check can
 * see what the hook decided without reading an opacity keyframe.
 *
 * **The gate is a hard off, not a shortening.** The fade animates `opacity`
 * through `motion/react`, which neither the global `prefers-reduced-motion`
 * CSS reset nor `MotionConfig reducedMotion="user"` reaches — that reset only
 * collapses CSS transition/animation durations, and `MotionConfig` only
 * suppresses transform and layout animations. An inline opacity tween keeps
 * running for a reader who asked for less motion unless something branches
 * off explicitly (`contributing/design-system.md`, "Reduced motion needs no
 * work for CSS, and for most Motion props").
 *
 * @param reducedMotion - The reader asked for less motion.
 */
export function shouldFadeRoute(reducedMotion: boolean): boolean {
  return !reducedMotion;
}

/** The one field of a TanStack Router match {@link routedPageKey} reads. */
export interface RoutedPageMatch {
  /** The path this match resolved, params filled in. */
  pathname: string;
}

/**
 * The key the routed page's fade wrapper remounts on: the path of the page the
 * `<Outlet />` is drawing, which is the deepest match.
 *
 * **Never `location.pathname`.** TanStack Router writes the new location the
 * moment a navigation starts and commits the new matches later, in a React
 * transition. In that gap the outlet still draws the page being left. A
 * wrapper keyed on the location therefore remounted the OLD page under the new
 * key: every one of its mount effects ran again (a room composer took the
 * caret, streams resubscribed), the fade played on the page on its way out,
 * and the new page then swapped in under the same key with no fade at all.
 * Measured on a phone-width switch from a Community back to Home, in dev and
 * production builds alike: the Community's composer mounted a second time
 * 7-47ms after the address changed and was replaced 27-126ms after that. The
 * matches change in the same commit as the outlet, so a key read from them
 * changes exactly when the page does.
 *
 * Still a pathname, not a full location, so switching sessions on `/session`
 * (a search change) keeps its own crossfade instead of taking two.
 *
 * @param matches - The router's committed matches, root first.
 * @returns The deepest match's path, or `''` before anything has matched.
 */
export function routedPageKey(matches: readonly RoutedPageMatch[]): string {
  return matches.at(-1)?.pathname ?? '';
}
