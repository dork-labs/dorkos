import { bandProgressAt, steadyBandIndex } from './stage-bands';

/** The three moments of the pinned stage, in scroll order. */
export type Beat = 'talk' | 'yours' | 'computer';

/** The beats in the order the stage plays them, so the step rail can count. */
export const BEAT_ORDER: readonly Beat[] = ['talk', 'yours', 'computer'];

/**
 * Where one beat becomes the next, as a fraction of the stage's scroll.
 *
 * These two numbers, plus the dead zone `stage/stage-bands.ts` puts around
 * each of them, are what the beat switch used to spell out as four thresholds
 * (0.34/0.38 and 0.62/0.66). They describe the same two boundaries, and now
 * the step rail can read them too — a rail with its own idea of where beat two
 * starts, next to a headline that changes somewhere else, is the confusion the
 * rail exists to remove.
 *
 * The finale reads them as well: nothing of the machine's arrival may begin
 * before the third beat's headline is on screen, which is this file's second
 * boundary plus its dead zone. `__tests__/stage-endings.test.ts` holds that
 * against `STAGE_TIMING` so the two cannot drift.
 */
export const BEAT_BOUNDARIES: readonly number[] = [0.36, 0.64];

/**
 * The beat at a point in the stage, keeping `current` while inside a
 * boundary's dead zone so a scroll that rests on one can't flicker between two
 * beats.
 */
export function nextBeat(progress: number, current: Beat): Beat {
  return BEAT_ORDER[steadyBandIndex(progress, BEAT_BOUNDARIES, BEAT_ORDER.indexOf(current))];
}

/** How far through its own beat the stage is, 0–1. */
export function beatProgressAt(progress: number): number {
  return bandProgressAt(progress, BEAT_BOUNDARIES);
}
