import type { Transition } from 'motion/react';

/**
 * How the handoff card settles into its one-line receipt (DOR-3112): its height
 * collapses while the two crossfade, so the composer below doesn't jump by the card's
 * whole height at once. Under reduced motion the swap is instant.
 *
 * @param reducedMotion - The person asked for reduced motion.
 */
export function receiptSwapTransition(reducedMotion: boolean | null): Transition {
  return reducedMotion ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' };
}
