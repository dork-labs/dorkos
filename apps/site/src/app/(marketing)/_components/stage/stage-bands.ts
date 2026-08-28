import { clamp01 } from '../motion-tokens';

/**
 * A stretch of scroll cut into steps, and the arithmetic the stage needs to
 * answer one question: where am I, and how much is left.
 *
 * The headline and the step rail are two readings of the same fact, and before
 * this they were two sets of numbers — four thresholds spelled out in the beat
 * switch, and whatever a rail decided to draw. A rail that fills at its own
 * pace next to a headline that changes somewhere else is worse than no rail,
 * so both now read the boundaries below, and the arithmetic lives here where
 * it can be checked without a browser.
 *
 * Boundaries are fractions of the whole stretch, in order, exclusive of 0 and
 * 1: `[0.36, 0.64]` describes three bands.
 */

/**
 * How far past a boundary the reader must be before the step changes.
 *
 * A scroll that comes to rest exactly on a boundary — a trackpad glide that
 * runs out, a phone that settles — would otherwise sit between two steps and
 * flip between them on every stray pixel.
 */
export const BAND_HYSTERESIS = 0.02;

/** Which band `progress` falls in, counting from zero. */
function bandIndexAt(progress: number, boundaries: readonly number[]): number {
  let index = 0;
  for (const boundary of boundaries) {
    if (progress >= boundary) index += 1;
  }
  return index;
}

/** Where a band starts and ends, as fractions of the whole stretch. */
function bandSpan(index: number, boundaries: readonly number[]): { start: number; end: number } {
  return {
    start: index <= 0 ? 0 : boundaries[index - 1],
    end: index >= boundaries.length ? 1 : boundaries[index],
  };
}

/**
 * Which band `progress` falls in, but sticky.
 *
 * Within `hysteresis` of the boundary being crossed the reader keeps the band
 * they are already in, so the indicator can't stutter on a scroll that stops
 * on the line. A jump of more than one band is let through regardless — that
 * is not a boundary rest, it is somebody moving.
 *
 * @param progress - Position through the whole stretch, 0–1.
 * @param boundaries - Where each band ends.
 * @param current - The band the reader is in now.
 * @param hysteresis - Half-width of the dead zone around a boundary.
 */
export function steadyBandIndex(
  progress: number,
  boundaries: readonly number[],
  current: number,
  hysteresis: number = BAND_HYSTERESIS
): number {
  const index = bandIndexAt(progress, boundaries);
  if (index === current) return current;
  const crossing = boundaries[Math.min(index, current)];
  return Math.abs(progress - crossing) < hysteresis ? current : index;
}

/** How far through its own band `progress` is, 0–1. */
export function bandProgressAt(progress: number, boundaries: readonly number[]): number {
  const { start, end } = bandSpan(bandIndexAt(progress, boundaries), boundaries);
  return clamp01((progress - start) / (end - start));
}
