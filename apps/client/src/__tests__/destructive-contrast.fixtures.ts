/** WCAG contrast math and token readers shared by the destructive-colour guards. */
import { expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/** The client `src` directory. */
export const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
/** The client stylesheet that bridges the package tokens. */
export const INDEX_CSS = join(SRC, 'index.css');
/** The shared UI package root. */
export const UI_ROOT = resolve(SRC, '../../../packages/ui');
/** The shared UI package source. */
export const UI_SRC = join(UI_ROOT, 'src');

/** WCAG AA threshold for normal-size text. */
export const AA = 4.5;

/** An sRGB colour, 0-255 per channel. */
export type Rgb = readonly [number, number, number];

/** Pure white. */
export const WHITE: Rgb = [255, 255, 255];

/**
 * An `H S% L%` triplet (the shape CSS custom properties store) to sRGB 0-255.
 *
 * @param h - Hue in degrees.
 * @param s - Saturation percent.
 * @param l - Lightness percent.
 */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
}

/** A `#rrggbb` hex to sRGB 0-255. */
export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of an sRGB colour. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two sRGB colours (order-independent). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Composite `fg` at `alpha` over an opaque `bg` — how the browser paints a
 * `bg-destructive/10` tint or a `dark:bg-destructive/60` fill.
 */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb;
}

/** The stretch of `index.css` between two markers, where one token block lives. */
export function section(css: string, start: string, end: string): string {
  const from = css.indexOf(start);
  const to = css.indexOf(end, from + start.length);
  expect(from, `marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `marker not found: ${end}`).toBeGreaterThan(from);
  return css.slice(from, to);
}

/** Resolve the client's shared aliases against the matching package theme. */
export function resolveSharedTokens(clientCss: string, paletteCss: string): string {
  return clientCss.replace(/var\((--dui-[a-z-]+)\)/g, (_, name: string) => {
    const declaration = paletteCss.match(new RegExp(`${name}:\\s*([^;]+);`));
    expect(declaration, `shared token not found: ${name}`).not.toBeNull();
    return declaration![1]!.trim();
  });
}

/** The `H S% L%` triplet a token holds inside one section. */
export function hsl(sectionCss: string, name: string): Rgb {
  const m = sectionCss.match(
    new RegExp(`${name}(?![a-z-]):\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`)
  );
  expect(m, `token not found: ${name}`).not.toBeNull();
  return hslToRgb(Number(m![1]), Number(m![2]), Number(m![3]));
}

/**
 * Assert every `[label, ratio]` clears `min`, naming the failures.
 *
 * One `expect` over the whole list, so a regression reports every pair that
 * broke rather than the first.
 */
export function expectAll(pairs: Record<string, number>, min = AA): void {
  const failing = Object.entries(pairs)
    .filter(([, ratio]) => ratio < min)
    .map(([name, ratio]) => `${name}: ${ratio.toFixed(2)}:1`);
  expect(failing).toEqual([]);
}
