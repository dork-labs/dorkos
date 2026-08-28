import type { Transition } from 'motion/react';

/** Bouncy spring shared by bubbles, layout shifts, and every shared-element flight. */
export const POP: Transition = { type: 'spring', stiffness: 460, damping: 26, mass: 0.9 };

/** Clamp a number into the 0–1 range. */
export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Map `v` onto 0–1 across the `from`–`to` window, clamped at both ends.
 * Used instead of `useTransform`'s keyframe form, which Motion promotes to a
 * native ScrollTimeline that mismaps these offsets.
 */
export function ramp(v: number, from: number, to: number): number {
  return clamp01((v - from) / (to - from));
}
