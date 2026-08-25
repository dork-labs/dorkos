/** The three moments of the pinned stage, in scroll order. */
export type Beat = 'talk' | 'yours' | 'computer';

/**
 * Beat thresholds with dead zones between them, so a scroll that rests on a
 * boundary can't flicker between two beats.
 */
export function nextBeat(progress: number, current: Beat): Beat {
  if (progress >= 0.66) return 'computer';
  if (progress <= 0.62 && progress >= 0.38) return 'yours';
  if (progress <= 0.34) return 'talk';
  return current;
}
