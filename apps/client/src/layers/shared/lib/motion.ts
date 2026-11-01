/**
 * The app's motion tokens: every speed, curve, spring and stagger in one place.
 *
 * `DURATION` and `EASE` are the same values `index.css` publishes as `--dur-*`
 * and `--ease-*`, so a `motion` animation and a CSS one move alike. A test holds
 * the two together. `check-design-tokens` keeps new spring numbers out of every
 * other file.
 *
 * @module shared/lib/motion
 */
import { MotionGlobalConfig } from 'motion/react';

/** How long a motion takes, in seconds. */
export const DURATION = {
  press: 0.08,
  instant: 0.1,
  fast: 0.15,
  normal: 0.2,
  slow: 0.3,
} as const;

/** The three curves, none of which overshoots. */
export const EASE = {
  out: [0, 0, 0.2, 1],
  in: [0.4, 0, 1, 1],
  standard: [0.4, 0, 0.2, 1],
} as const;

/**
 * The three springs. Each damping ratio is at least 0.9, so none visibly bounces.
 *
 * - `snap`: small controls, badges and marks.
 * - `glide`: something arriving, or sliding to a new place.
 * - `fold`: a section opening or closing.
 */
export const SPRING = {
  snap: { type: 'spring', stiffness: 400, damping: 40 },
  glide: { type: 'spring', stiffness: 280, damping: 32 },
  fold: { type: 'spring', stiffness: 400, damping: 36 },
} as const;

/** A list's entrance: seconds between items, and how many items wait their turn. */
export const STAGGER = { step: 0.035, max: 8 } as const;

/**
 * Make every `motion` animation finish at once while the reader asks for less
 * motion, and follow that setting if it changes.
 *
 * One switch rather than a `useReducedMotion` at each spring, because many
 * springs are module constants that a hook cannot reach. `MotionConfig
 * reducedMotion="user"` is not enough by itself: it drops movement but still
 * runs a spring's fade.
 */
export function installReducedMotion(): void {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const apply = () => {
    MotionGlobalConfig.skipAnimations = query.matches;
  };
  apply();
  query.addEventListener('change', apply);
}
