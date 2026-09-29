/**
 * The gauge's fill: a unit-free ratio of two amounts, so it needs no credit
 * scale. These pin the two ends and the no-denominator case.
 */
import { describe, it, expect } from 'vitest';
import { remainingFraction } from '../lib/remaining-fraction';

describe('the credits gauge fill', () => {
  it('refuses to draw a gauge with no denominator', () => {
    expect(remainingFraction('0', '0')).toBeNull();
    expect(remainingFraction('5', 'nope')).toBeNull();
  });

  it('clamps the gauge to its own ends', () => {
    expect(remainingFraction('1250000', '5000000')).toBeCloseTo(0.25);
    expect(remainingFraction('9000000', '5000000')).toBe(1);
    expect(remainingFraction('0', '5000000')).toBe(0);
  });

  it('keeps a ratio of amounts larger than a double can hold', () => {
    // 2^53 + 1 and 2 × (2^53 + 1): a Number would lose the odd unit; the ratio
    // is exactly one half either way, and BigInt keeps it so.
    expect(remainingFraction('9007199254740993', '18014398509481986')).toBe(0.5);
  });
});
