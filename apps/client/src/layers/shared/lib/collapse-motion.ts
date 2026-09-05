/**
 * The height-collapse gesture, once.
 *
 * Fifteen call sites hand-rolled the same three-line variant object for the same
 * reveal, at 200ms, 250ms and 300ms depending on which file you landed in, under
 * three different local names — two of them byte-identical constants declared in
 * separate files (DOR-1763 finding 17.8). `contributing/animations.md` already
 * publishes this exact shape and says to define it at module scope; nothing
 * exported it, so everybody retyped it and picked a number.
 *
 * 200ms with an ease-out curve is the app's collapse speed. Expanding a tool
 * card and then a task row is the same gesture, so it cannot be two speeds.
 *
 * @module shared/lib/collapse-motion
 */

/** The three states of a height collapse: closed, open, closed again. */
export const COLLAPSE_VARIANTS = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

/**
 * The collapse timing.
 *
 * Ease-out rather than a spring: spring physics on height overshoot, and a
 * panel that bounces past its own content and back is exactly the drama Calm
 * Tech spends its budget avoiding.
 */
export const COLLAPSE_TRANSITION = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;
