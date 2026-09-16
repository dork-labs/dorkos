import { describe, it, expect } from 'vitest';
import { formatMicro, remainingFraction } from '../lib/micro';

describe('micro-unit rendering', () => {
  it('divides by a million without ever building a Number from the wire value', () => {
    expect(formatMicro('0')).toBe('0.00');
    expect(formatMicro('1250000')).toBe('1.25');
    expect(formatMicro('48000000')).toBe('48.00');
    expect(formatMicro('-2500000')).toBe('-2.50');
  });

  it('does not let the viewer`s locale move the decimal point', () => {
    // A bare `toLocaleString()` groups with `.` in de-DE while the decimal point
    // below stays a `.`, so the figure reads as a different number entirely.
    const original = Intl.NumberFormat;
    try {
      Intl.NumberFormat = function (_locale?: unknown, options?: Intl.NumberFormatOptions) {
        return new original('de-DE', options);
      } as unknown as typeof Intl.NumberFormat;
      expect(formatMicro('1234567000000')).toBe('1,234,567.00');
    } finally {
      Intl.NumberFormat = original;
    }
  });

  it('keeps an amount larger than a double can hold exactly', () => {
    // 2^53 is where a double starts skipping integers; micro-units reach that
    // an order of magnitude sooner than anybody expects.
    expect(formatMicro('9007199254740993000000')).toBe('9,007,199,254,740,993.00');
  });

  it('rounds to hundredths rather than truncating, so a figure never reads low', () => {
    expect(formatMicro('1995000')).toBe('2.00');
    expect(formatMicro('1994999')).toBe('1.99');
  });

  it('renders nothing for anything that is not a micro-unit integer string', () => {
    expect(formatMicro(undefined)).toBeNull();
    expect(formatMicro(null)).toBeNull();
    expect(formatMicro('1.25')).toBeNull();
    expect(formatMicro('lots')).toBeNull();
  });

  it('refuses to draw a gauge with no denominator', () => {
    expect(remainingFraction('0', '0')).toBeNull();
    expect(remainingFraction('5', 'nope')).toBeNull();
  });

  it('clamps the gauge to its own ends', () => {
    expect(remainingFraction('1250000', '5000000')).toBeCloseTo(0.25);
    expect(remainingFraction('9000000', '5000000')).toBe(1);
    expect(remainingFraction('0', '5000000')).toBe(0);
  });
});
