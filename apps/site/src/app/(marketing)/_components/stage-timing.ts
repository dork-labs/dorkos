import { ramp } from './motion-tokens';

/**
 * Where each visual change happens along the pinned stage, as a fraction of
 * its scroll. Tuning the animation means editing these numbers — the live
 * page and `/test/storyboard` both read them, so they cannot drift apart.
 */
export const STAGE_TIMING = {
  /** The chat starts shrinking toward the laptop. */
  shrinkFrom: 0.68,
  /** The chat has reached its final size. */
  shrinkTo: 0.92,
  /** How much of its size the chat gives up (1 → 0.54). */
  shrinkAmount: 0.46,
  /** The laptop shell begins to appear. */
  shellFrom: 0.78,
  /** The laptop shell is fully solid. */
  shellTo: 0.9,
  /** The closing caption begins to appear. */
  captionFrom: 0.9,
  /** The closing caption is fully legible. */
  captionTo: 0.98,
} as const;

/** Scale of the chat card at a given point in the stage. */
export function chatScaleAt(progress: number): number {
  return (
    1 - ramp(progress, STAGE_TIMING.shrinkFrom, STAGE_TIMING.shrinkTo) * STAGE_TIMING.shrinkAmount
  );
}

/** Opacity of the laptop bezel and base at a given point in the stage. */
export function shellOpacityAt(progress: number): number {
  return ramp(progress, STAGE_TIMING.shellFrom, STAGE_TIMING.shellTo);
}

/** Opacity of the "home sweet localhost" caption at a given point. */
export function captionOpacityAt(progress: number): number {
  return ramp(progress, STAGE_TIMING.captionFrom, STAGE_TIMING.captionTo);
}
