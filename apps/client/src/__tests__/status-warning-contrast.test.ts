// @vitest-environment node
/**
 * The amber warning TEXT token (`--status-warning-fg`) clears WCAG AA (4.5:1
 * for normal text) in light mode, and dark mode stays comfortably above it
 * (DOR-2444).
 *
 * `--status-warning-fg` used to equal `--status-warning-dot` (`38 92% 40%`).
 * `-dot` is deliberately tuned for the *non-text* 1.4.11 bar (3:1) a 6px mark
 * needs, not the 4.5:1 bar running text needs — so reusing it as `-fg` left
 * warning text under AA everywhere it painted: 3.29:1 on white, 3.10:1 on the
 * amber `-bg` wash, and as low as 2.75:1 on `--secondary`. The light token
 * was darkened to `38 92% 30%` — `--secondary` (92% lightness) is the
 * darkest common ground it is actually painted on, so the tightest ratio
 * (4.51:1); every lighter ground clears with more room. This guard is what
 * keeps it there. `-dot` itself is unchanged and is checked only against the
 * 3:1 non-text bar it was designed for.
 *
 * Same method as `status-success-contrast.test.ts`: contrast needs layout,
 * and jsdom has none, so this owns the token math — read the shipped value,
 * run it through the same WCAG formula the browser applies, against the
 * ground it is painted on — with the discriminator proven both ways first (the
 * OLD value fails, the shipped one passes) so a broken contrast function or
 * HSL parser cannot make every other assertion here meaningless.
 *
 * @module __tests__/status-warning-contrast
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const INDEX_CSS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../index.css');
const UI_TOKENS_CSS = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../packages/ui/tokens.css'
);

/** WCAG AA threshold for normal-size text. */
const AA = 4.5;
/** WCAG 1.4.11 threshold for a non-text graphical mark (the warning dot/icon). */
const NON_TEXT = 3;

type Rgb = readonly [number, number, number];

/**
 * An `H S% L%` triplet (the shape CSS custom properties store) to sRGB 0-255.
 *
 * @param h - Hue in degrees.
 * @param s - Saturation percent.
 * @param l - Lightness percent.
 */
function hslToRgb(h: number, s: number, l: number): Rgb {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** WCAG relative luminance of an sRGB colour. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two sRGB colours (order-independent). */
function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The stretch of `index.css` between two markers, where one token block lives. */
function section(css: string, start: string, end: string): string {
  const from = css.indexOf(start);
  const to = css.indexOf(end, from + start.length);
  expect(from, `marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `marker not found: ${end}`).toBeGreaterThan(from);
  return css.slice(from, to);
}

/** The `H S% L%` triplet a token holds inside one section. */
function hsl(sectionCss: string, name: string, sharedTokens?: string): Rgb {
  const value = sectionCss.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
  const alias = value?.match(/^var\((--dui-[a-z-]+)\)$/);
  if (alias) {
    expect(sharedTokens, `shared tokens not loaded for ${name}`).toBeDefined();
    return hsl(sharedTokens!, alias[1]);
  }
  const m = value?.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  expect(m, `token not found: ${name}`).toBeTruthy();
  return hslToRgb(Number(m![1]), Number(m![2]), Number(m![3]));
}

describe('status-warning contrast', () => {
  const css = readFileSync(INDEX_CSS, 'utf8');
  // The light declarations live in `:root, .light { ... }`, the dark ones in
  // `.dark { ... }`. Slicing by the block openers keeps the two `--status-warning-*`
  // values apart — reading the wrong block would compare a value against itself.
  const light = section(css, ':root,', '.dark {');
  const dark = section(css, '.dark {', '@layer border-defaults');
  // Portable surfaces bridge to @dork-labs/ui; measure the exact package
  // triplet selected by each client block instead of assuming it is inlined.
  const uiTokens = readFileSync(UI_TOKENS_CSS, 'utf8');
  const sharedLight = section(uiTokens, ':root,', '@media');
  const sharedDark = uiTokens.slice(uiTokens.lastIndexOf('\n.dark {'));
  const lightHsl = (name: string) => hsl(light, name, sharedLight);
  const darkHsl = (name: string) => hsl(dark, name, sharedDark);

  // --- The math, pinned before it is trusted ---

  it('computes known contrast pairs correctly', () => {
    const white: Rgb = [255, 255, 255];
    const black: Rgb = [0, 0, 0];
    expect(contrast(black, white)).toBeCloseTo(21, 0);
    expect(contrast(white, white)).toBeCloseTo(1, 5);
    expect(contrast(black, black)).toBeCloseTo(1, 5);
  });

  it('parses HSL into a distinct, correct colour', () => {
    expect(hslToRgb(0, 0, 100)).toEqual([255, 255, 255]);
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0]);
    // An amber whose R channel dominates — proves hue is honoured, not ignored.
    const [r, g, b] = hslToRgb(38, 92, 30);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('discriminates: the OLD 40% amber FAILS as text on --secondary, the shipped 30% PASSES', () => {
    const secondary = hslToRgb(0, 0, 92); // --secondary (light) — the darkest common ground in practice
    // The bug this change fixes: reusing `-dot`'s 40% as `-fg` measured 2.75:1
    // on --secondary — well under AA. If the math cannot see that, no pass
    // below is trustworthy.
    expect(contrast(hslToRgb(38, 92, 40), secondary)).toBeLessThan(AA);
    // And the shipped value must clear it — read from the file, not hard-coded.
    expect(contrast(lightHsl('--status-warning-fg'), secondary)).toBeGreaterThanOrEqual(AA);
  });

  // --- The assertions those checks earn, against the real shipped tokens ---

  it('warning text (-fg) clears AA on every light ground it is painted on', () => {
    const amber = lightHsl('--status-warning-fg');
    const grounds = {
      'app (--background)': lightHsl('--background'),
      'card (--card)': lightHsl('--card'),
      'muted (--muted)': lightHsl('--muted'),
      'accent (--accent)': lightHsl('--accent'),
      'secondary (--secondary)': lightHsl('--secondary'),
      "warning's own wash (--status-warning-bg)": lightHsl('--status-warning-bg'),
    };
    for (const [name, ground] of Object.entries(grounds)) {
      expect({ name, ratio: contrast(amber, ground) >= AA }).toEqual({ name, ratio: true });
    }
  });

  it('the warning dot/icon (-dot) clears the 3:1 non-text bar, not the 4.5:1 text bar', () => {
    const dot = lightHsl('--status-warning-dot');
    expect(contrast(dot, lightHsl('--card'))).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it('dark mode -fg stays comfortably above AA and is not regressed', () => {
    const amber = darkHsl('--status-warning-fg');
    expect(contrast(amber, darkHsl('--background'))).toBeGreaterThanOrEqual(AA);
    expect(contrast(amber, darkHsl('--card'))).toBeGreaterThanOrEqual(AA);
    expect(contrast(amber, darkHsl('--status-warning-bg'))).toBeGreaterThanOrEqual(AA);
  });
});
