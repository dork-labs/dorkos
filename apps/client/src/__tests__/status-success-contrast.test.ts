// @vitest-environment node
/**
 * The green success token clears WCAG AA (4.5:1 for normal text) in light mode,
 * and dark mode stays comfortably above it (DOR-1431).
 *
 * Green carries meaning as TEXT (the dial caption, the status word, the "running
 * unattended at full power" notes, session-row marks) and as the inverted white
 * label on a green fill (the full-power door's CTA). At `152 69% 31%` those
 * surfaces measured 4.2-4.5:1 — under the bar — so two reviews flagged them. The
 * light token was darkened to `152 69% 24%`; this guard is what keeps it there.
 *
 * **Contrast needs layout, and jsdom has none** — the true proof is the browser
 * measurement recorded in the PR. What a unit test CAN own is the token itself:
 * the value shipped in `index.css`, run through the same WCAG math the browser
 * applies, against the ground it is painted on. If someone lightens the token
 * back toward the old value, this turns red.
 *
 * **A check that reads a token and computes a number can pass while its own math
 * is broken.** So the WCAG helpers are pinned against known pairs first (black on
 * white is 21:1, a colour on itself is 1:1), and the discriminator is proven both
 * ways: the OLD `31%` green is asserted to FAIL on the app background, and the
 * shipped `24%` to PASS. A contrast function that returned a constant, or an HSL
 * parser that returned the same colour for every input, is caught before any
 * assertion about the real token is allowed to mean anything.
 *
 * @module __tests__/status-success-contrast
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const INDEX_CSS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../index.css');

/** WCAG AA threshold for normal-size text. */
const AA = 4.5;

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

/** A `#rrggbb` hex to sRGB 0-255. */
function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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

/**
 * Composite `fg` at `alpha` over an opaque `bg` — how the browser paints a
 * `bg-status-success/15` wash. WCAG runs against the resolved opaque colour.
 */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as unknown as Rgb;
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
function hsl(sectionCss: string, name: string): Rgb {
  const m = sectionCss.match(new RegExp(`${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
  expect(m, `token not found: ${name}`).not.toBeNull();
  return hslToRgb(Number(m![1]), Number(m![2]), Number(m![3]));
}

describe('status-success contrast', () => {
  const css = readFileSync(INDEX_CSS, 'utf8');
  // The light declarations live in `:root, .light { ... }`, the dark ones in
  // `.dark { ... }`. Slicing by the block openers keeps the two `--status-success`
  // values apart — reading the wrong block would compare a value against itself.
  const light = section(css, ':root,', '.dark {');
  const dark = section(css, '.dark {', '.copilot-view-content');

  // --- The math, pinned before it is trusted ---

  it('computes known contrast pairs correctly', () => {
    const white: Rgb = [255, 255, 255];
    const black: Rgb = [0, 0, 0];
    expect(contrast(black, white)).toBeCloseTo(21, 0);
    expect(contrast(white, white)).toBeCloseTo(1, 5);
    expect(contrast(black, black)).toBeCloseTo(1, 5);
  });

  it('parses HSL and hex into distinct, correct colours', () => {
    expect(hslToRgb(0, 0, 100)).toEqual([255, 255, 255]);
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0]);
    // A green whose G channel dominates — proves hue is honoured, not ignored.
    const [r, g, b] = hslToRgb(152, 69, 24);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(hexToRgb('#15803d')).toEqual([21, 128, 61]);
  });

  it('discriminates: the OLD 31% green FAILS on the app background, the shipped one PASSES', () => {
    const app = hslToRgb(0, 0, 98);
    // The bug this change fixes: 31% missed AA. If the math cannot see that, no
    // pass below is trustworthy.
    expect(contrast(hslToRgb(152, 69, 31), app)).toBeLessThan(AA);
    // And the shipped value must clear it — read from the file, not hard-coded.
    expect(contrast(hsl(light, '--status-success'), app)).toBeGreaterThanOrEqual(AA);
  });

  // --- The assertions those checks earn, against the real shipped tokens ---

  it('green text clears AA on every light ground it is painted on', () => {
    const green = hsl(light, '--status-success');
    const grounds = {
      'app (--background)': hsl(light, '--background'),
      'card (--card)': hsl(light, '--card'),
      'muted (--muted)': hsl(light, '--muted'),
      'sidebar (--sidebar)': hsl(light, '--sidebar'),
    };
    for (const [name, ground] of Object.entries(grounds)) {
      expect({ name, ratio: contrast(green, ground) >= AA }).toEqual({ name, ratio: true });
    }
  });

  it('the -fg text clears AA on the light green -bg fill (info boxes)', () => {
    expect(
      contrast(hsl(light, '--status-success-fg'), hsl(light, '--status-success-bg'))
    ).toBeGreaterThanOrEqual(AA);
  });

  it('the inverted white label clears AA on the green fill (door CTA)', () => {
    expect(contrast([255, 255, 255], hsl(light, '--status-success'))).toBeGreaterThanOrEqual(AA);
  });

  it('the green-on-green wash chips clear AA over the darkest ground (sidebar)', () => {
    // `bg-status-success/15` (the "N live" chip) and `/10` (the room run pill)
    // are a tint of the green over gray — the hardest surface a token change can
    // reach. Measured over the sidebar, the darkest common ground.
    const green = hsl(light, '--status-success');
    const sidebar = hsl(light, '--sidebar');
    expect(contrast(green, over(green, 0.15, sidebar))).toBeGreaterThanOrEqual(AA);
    expect(contrast(green, over(green, 0.1, sidebar))).toBeGreaterThanOrEqual(AA);
  });

  it('dark mode stays comfortably above AA (>= 7:1) and is not regressed', () => {
    const green = hsl(dark, '--status-success');
    expect(contrast(green, hsl(dark, '--background'))).toBeGreaterThanOrEqual(7);
    expect(contrast(green, hsl(dark, '--card'))).toBeGreaterThanOrEqual(7);
  });

  it('the Obsidian flat green pin clears AA on the Obsidian light theme (white)', () => {
    const obsidian = section(css, '.copilot-view-content {', '\n}');
    const m = obsidian.match(/--color-status-success:\s*(#[0-9a-fA-F]{6})/);
    expect(m, 'Obsidian --color-status-success pin not found').not.toBeNull();
    expect(contrast(hexToRgb(m![1]), [255, 255, 255])).toBeGreaterThanOrEqual(AA);
  });
});
