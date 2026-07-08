import { describe, it, expect } from 'vitest';
import { parseStatValue, formatStatValue } from '../lib/stat-format';

describe('parseStatValue', () => {
  it('parses a plain number', () => {
    expect(parseStatValue(42)).toEqual({
      prefix: '',
      suffix: '',
      decimals: 0,
      grouped: false,
      value: 42,
    });
  });

  it('keeps a currency prefix and a per-unit suffix', () => {
    expect(parseStatValue('$1,234/mo')).toEqual({
      prefix: '$',
      suffix: '/mo',
      decimals: 0,
      grouped: true,
      value: 1234,
    });
  });

  it('preserves decimals and a unit suffix', () => {
    const parsed = parseStatValue('64.5°F');
    expect(parsed).toMatchObject({ prefix: '', suffix: '°F', decimals: 1, value: 64.5 });
  });

  it('returns null for non-numeric values', () => {
    expect(parseStatValue('Online')).toBeNull();
    expect(parseStatValue(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatStatValue', () => {
  it('restores prefix, suffix, decimals, and grouping mid-count', () => {
    const parsed = parseStatValue('$1,234.50')!;
    expect(formatStatValue(parsed, 617.25)).toBe('$617.25');
    expect(formatStatValue(parsed, 1234.5)).toBe('$1,234.50');
  });

  it('rounds to the parsed decimal precision', () => {
    const parsed = parseStatValue('64°F')!;
    expect(formatStatValue(parsed, 31.7)).toBe('32°F');
  });
});
