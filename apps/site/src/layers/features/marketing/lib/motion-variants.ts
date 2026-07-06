import type { Variants, Transition } from 'motion/react';

/** Overdamped spring — physics-based, no bounce. */
export const SPRING: Transition = {
  type: 'spring',
  stiffness: 100,
  damping: 20,
  mass: 1,
};

/** Fast tween for content reveals — keeps every reveal ≤300ms so nothing lingers blank. */
export const REVEAL_TRANSITION: Transition = { duration: 0.3, ease: 'easeOut' };

/**
 * Standard viewport trigger config. Fires once, and the bottom `margin`
 * extends the observer root ~120px below the fold so reveals start before
 * the element scrolls fully into view — content is opaque by the time it lands.
 */
export const VIEWPORT = { once: true, amount: 0.15, margin: '0px 0px 120px 0px' } as const;

/** Viewport config that replays the animation every time the element re-enters view. */
export const VIEWPORT_REPEAT = { once: false, amount: 0.15, margin: '0px 0px 120px 0px' } as const;

/** Fade + slide up reveal for individual elements. */
export const REVEAL: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: REVEAL_TRANSITION,
  },
};

/** Container variant that staggers children at 80ms intervals. */
export const STAGGER: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.08,
    },
  },
};

/** Scale-in variant for SVG nodes. */
export const SCALE_IN: Variants = {
  hidden: { opacity: 0, scale: 0 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: SPRING,
  },
};

/** Path drawing variant using pathLength. */
export const DRAW_PATH: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 1.2, ease: 'easeInOut' },
  },
};
