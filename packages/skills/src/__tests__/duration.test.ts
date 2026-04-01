import { describe, it, expect } from 'vitest';
import { DurationSchema, parseDuration, formatDuration } from '../duration.js';

describe('DurationSchema', () => {
  it('accepts valid duration strings', () => {
    expect(DurationSchema.safeParse('5m').success).toBe(true);
    expect(DurationSchema.safeParse('1h').success).toBe(true);
    expect(DurationSchema.safeParse('30s').success).toBe(true);
    expect(DurationSchema.safeParse('2h30m').success).toBe(true);
    expect(DurationSchema.safeParse('1h15m30s').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(DurationSchema.safeParse('').success).toBe(false);
  });

  it('rejects invalid duration strings', () => {
    expect(DurationSchema.safeParse('abc').success).toBe(false);
    expect(DurationSchema.safeParse('5').success).toBe(false);
    expect(DurationSchema.safeParse('5x').success).toBe(false);
    expect(DurationSchema.safeParse('five minutes').success).toBe(false);
  });
});

describe('parseDuration', () => {
  it('parses minutes only', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours only', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses seconds only', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses combined duration', () => {
    expect(parseDuration('2h30m')).toBe(9_000_000);
  });

  it('parses full hours+minutes+seconds', () => {
    expect(parseDuration('1h15m30s')).toBe(4_530_000);
  });

  it('returns 0 for empty-ish input', () => {
    expect(parseDuration('')).toBe(0);
  });
});

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(9_000_000)).toBe('2h30m');
  });

  it('formats zero as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats seconds only', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('formats large values', () => {
    expect(formatDuration(86_400_000)).toBe('24h');
  });

  it('round-trips with parseDuration', () => {
    expect(formatDuration(parseDuration('2h30m'))).toBe('2h30m');
    expect(formatDuration(parseDuration('1h15m30s'))).toBe('1h15m30s');
    expect(formatDuration(parseDuration('5m'))).toBe('5m');
  });
});
