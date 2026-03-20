import type { Variants, Transition } from 'motion/react';

/** Overdamped spring — physics-based, no bounce. */
export const SPRING: Transition = {
  type: 'spring',
  stiffness: 100,
  damping: 20,
  mass: 1,
};

/** Standard viewport trigger config — fires once at 20% visible. */
export const VIEWPORT = { once: true, amount: 0.2 } as const;

/** Viewport config that replays the animation every time the element re-enters view. */
export const VIEWPORT_REPEAT = { once: false, amount: 0.2 } as const;

/** Fade + slide up reveal for individual elements. */
export const REVEAL: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: SPRING,
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
