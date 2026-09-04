/**
 * Whether the routed page may cross-fade in on navigation (DOR-1764).
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
