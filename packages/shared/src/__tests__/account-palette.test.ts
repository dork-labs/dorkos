import { describe, it, expect } from 'vitest';
import { DEFAULT_ACCOUNT_COLORS } from '../account-usage.js';

/** Every surface an account dot sits on, light and dark. */
const SURFACES = ['#ffffff', '#fafafa', '#e8e8e8', '#0a0a0a', '#1a1a1a', '#262626'];

/** The decided palette and each value's minimum contrast over {@link SURFACES}. */
const DECIDED: Array<[name: string, hex: string, minContrast: number]> = [
  ['blue', '#2f7be0', 3.41],
  ['green', '#1d8a4a', 3.45],
  ['amber', '#c2680a', 3.25],
  ['purple', '#9b51e0', 3.35],
  ['pink', '#d6336c', 3.28],
  ['teal', '#0d9488', 3.06],
  ['indigo', '#6366f1', 3.39],
  ['stone', '#78716c', 3.15],
];

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function hue(hex: string): number {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('DEFAULT_ACCOUNT_COLORS', () => {
  it('is the decided palette, in default-by-position order', () => {
    expect(DEFAULT_ACCOUNT_COLORS).toEqual(DECIDED.map(([, hex]) => hex));
  });

  it('holds 8 distinct lowercase #rrggbb values', () => {
    expect(DEFAULT_ACCOUNT_COLORS).toHaveLength(8);
    expect(new Set(DEFAULT_ACCOUNT_COLORS).size).toBe(8);
    for (const hex of DEFAULT_ACCOUNT_COLORS) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(DECIDED)('%s %s is at least 3:1 on every surface (%s)', (_name, hex, expected) => {
    const min = Math.min(...SURFACES.map((surface) => contrast(hex, surface)));
    expect(min).toBeGreaterThanOrEqual(3);
    expect(min.toFixed(2)).toBe(expected.toFixed(2));
  });

  it('has no red, because red means out of usage', () => {
    for (const hex of DEFAULT_ACCOUNT_COLORS) {
      const h = hue(hex);
      expect(h > 15 && h < 345, `${hex} has hue ${h.toFixed(0)}`).toBe(true);
    }
  });
});
