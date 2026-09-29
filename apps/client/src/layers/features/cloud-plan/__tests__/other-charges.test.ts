/** The Other charges helpers: a charged quantity, and the days a billing period covers. */
import { describe, expect, it } from 'vitest';
import { formatPeriod, formatUnits } from '../lib/other-charges';

describe('formatPeriod', () => {
  it('shows the last day covered when the exclusive end is midnight UTC', () => {
    expect(formatPeriod('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(
      'Sep 1 – Sep 30'
    );
  });

  it('shows an end that is not midnight UTC as sent, never a day earlier', () => {
    expect(formatPeriod('2026-09-01T00:00:00.000Z', '2026-10-01T12:00:00.000Z')).toBe(
      'Sep 1 – Oct 1'
    );
    expect(formatPeriod('2026-09-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z')).toBe(
      'Sep 1 – Sep 30'
    );
  });
});

describe('formatUnits', () => {
  it('keeps up to three decimals and the service`s own unit', () => {
    expect(formatUnits(3.719, 'GB-month')).toBe('3.719 GB-month');
    expect(formatUnits(1234.5, 'widget-days')).toBe('1,234.5 widget-days');
  });
});
