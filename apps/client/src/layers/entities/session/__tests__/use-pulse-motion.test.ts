/**
 * The pulse's reduced-motion gate, tested where it can be tested.
 *
 * The animation itself is a `repeat: Infinity` colour tween, and neither
 * `MotionConfig reducedMotion="user"` nor the CSS reset reaches colour — so
 * this rule is the whole protection, and jsdom can assert none of it through
 * the motion props (the harness strips them). Testing the pure function and
 * having the rows report the same boolean as `data-pulsing` is how the two
 * halves are kept from drifting.
 *
 * @module entities/session/__tests__/use-pulse-motion
 */
import { describe, it, expect } from 'vitest';
import { shouldPulse } from '../model/status/use-pulse-motion';

describe('shouldPulse', () => {
  it('pulses when the state asks for it and there is a colour to fade to', () => {
    expect(shouldPulse(true, '#0a0', false)).toBe(true);
  });

  it('never pulses for a reader who asked for less motion', () => {
    expect(shouldPulse(true, '#0a0', true)).toBe(false);
  });

  it('never pulses without a dim colour — there would be nothing to tween to', () => {
    expect(shouldPulse(true, undefined, false)).toBe(false);
  });

  it('never pulses when the state does not ask', () => {
    expect(shouldPulse(false, '#0a0', false)).toBe(false);
  });
});
