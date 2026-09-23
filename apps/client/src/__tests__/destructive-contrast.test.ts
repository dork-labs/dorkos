// @vitest-environment node
/**
 * The destructive red clears WCAG AA (4.5:1 for normal text) wherever it is
 * painted, in light AND dark mode.
 *
 * Red plays two parts. It is TEXT (every error message, "Delete" in a menu,
 * a failed run's explanation) and it is a FILL under a white label (the
 * destructive button, a "Failed" badge, the composer's Stop button). An
 * accessibility audit (PR #2040) measured both under the bar: white on the red
 * button 3.76:1, red error text 3.6:1 in light mode and 4.09:1 in dark. The
 * tokens were moved in OKLCH lightness only, hue and chroma held, and this
 * guard is what keeps them there.
 *
 * **Dark mode cannot be fixed by one colour.** Red text on near-black needs a
 * luminance above ~0.19; a white label on red needs one below ~0.18. So the
 * dark token is tuned for text, and every solid fill that carries a label dims
 * itself with `dark:bg-destructive/60` (what `button.tsx`'s destructive
 * variant already did). The last block below reads the source to make sure a
 * new solid fill cannot skip that.
 *
 * **Contrast needs layout, and jsdom has none.** The browser measurement is in
 * the PR. What a unit test CAN own is the token: the value shipped in
 * `index.css`, run through the WCAG math against the ground it sits on. The
 * math is pinned against known pairs first, and the discriminator is proven
 * both ways (the OLD values fail, the shipped ones pass), so a contrast
 * function that returned a constant cannot make the real assertions pass.
 *
 * @module __tests__/destructive-contrast
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const INDEX_CSS = join(SRC, 'index.css');

/** WCAG AA threshold for normal-size text. */
const AA = 4.5;

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];

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
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
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
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
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
 * `bg-destructive/10` tint or a `dark:bg-destructive/60` fill.
 */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb;
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
function expectAll(pairs: Record<string, number>, min = AA): void {
  const failing = Object.entries(pairs)
    .filter(([, ratio]) => ratio < min)
    .map(([name, ratio]) => `${name}: ${ratio.toFixed(2)}:1`);
  expect(failing).toEqual([]);
}

describe('destructive contrast', () => {
  const css = readFileSync(INDEX_CSS, 'utf8');
  // Light declarations live in `:root, .light { ... }`, dark ones in
  // `.dark { ... }`. Slicing by the block openers keeps the two
  // `--destructive` values apart.
  const light = section(css, ':root,', '.dark {');
  const dark = section(css, '.dark {', '.copilot-view-content');

  // --- The math, pinned before it is trusted ---

  it('computes known contrast pairs correctly', () => {
    expect(contrast([0, 0, 0], WHITE)).toBeCloseTo(21, 0);
    expect(contrast(WHITE, WHITE)).toBeCloseTo(1, 5);
    // Tailwind red-500 (#ef4444) under white is a well-known 3.76:1.
    expect(contrast(hexToRgb('#ef4444'), WHITE)).toBeCloseTo(3.76, 2);
  });

  it('parses HSL and hex into distinct, correct colours', () => {
    expect(hslToRgb(0, 0, 100)).toEqual([255, 255, 255]);
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0]);
    expect(hslToRgb(0, 84.2, 60.2).map(Math.round)).toEqual([239, 68, 68]);
    expect(hexToRgb('#ca1c27')).toEqual([202, 28, 39]);
  });

  it('discriminates: the OLD reds FAIL, the shipped ones PASS', () => {
    const lightBg = hslToRgb(0, 0, 98);
    const darkBg = hslToRgb(0, 0, 4);
    // The audit's numbers. If the math cannot see these, no pass below counts.
    expect(contrast(hslToRgb(0, 84.2, 60.2), lightBg)).toBeLessThan(AA);
    expect(contrast(WHITE, hslToRgb(0, 84.2, 60.2))).toBeLessThan(AA);
    expect(contrast(hslToRgb(0, 72, 50.5), darkBg)).toBeLessThan(AA);
    // And the shipped values clear it, read from the file.
    expect(contrast(hsl(light, '--destructive'), lightBg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(hsl(dark, '--destructive'), darkBg)).toBeGreaterThanOrEqual(AA);
  });

  // --- Light mode: one red does both jobs ---

  it('light: red text clears AA on every ground it is painted on', () => {
    const red = hsl(light, '--destructive');
    const bg = hsl(light, '--background');
    expectAll({
      background: contrast(red, bg),
      card: contrast(red, hsl(light, '--card')),
      popover: contrast(red, hsl(light, '--popover')),
      muted: contrast(red, hsl(light, '--muted')),
      'accent (hovered row)': contrast(red, hsl(light, '--accent')),
      sidebar: contrast(red, hsl(light, '--sidebar')),
      'bg-destructive/5 tint': contrast(red, over(red, 0.05, bg)),
      'bg-destructive/10 tint': contrast(red, over(red, 0.1, bg)),
      'text-destructive/90': contrast(over(red, 0.9, bg), bg),
    });
  });

  it('light: the label clears AA on the solid red fill, resting and hovered', () => {
    const red = hsl(light, '--destructive');
    const label = hsl(light, '--destructive-foreground');
    const bg = hsl(light, '--background');
    expectAll({
      'text-white on bg-destructive': contrast(WHITE, red),
      'text-destructive-foreground on bg-destructive': contrast(label, red),
      'text-white on hover:bg-destructive/90': contrast(WHITE, over(red, 0.9, bg)),
      'text-destructive-foreground on hover:bg-destructive/90': contrast(label, over(red, 0.9, bg)),
    });
  });

  // --- Dark mode: text red, fills dimmed ---

  it('dark: red text clears AA on every ground it is painted on', () => {
    const red = hsl(dark, '--destructive');
    const bg = hsl(dark, '--background');
    const popover = hsl(dark, '--popover');
    expectAll({
      background: contrast(red, bg),
      card: contrast(red, hsl(dark, '--card')),
      popover: contrast(red, popover),
      muted: contrast(red, hsl(dark, '--muted')),
      'accent (hovered row)': contrast(red, hsl(dark, '--accent')),
      secondary: contrast(red, hsl(dark, '--secondary')),
      sidebar: contrast(red, hsl(dark, '--sidebar')),
      'bg-destructive/10 tint': contrast(red, over(red, 0.1, bg)),
      // The destructive menu item's focus highlight (`dark:…focus:bg-destructive/20`).
      'bg-destructive/20 menu highlight': contrast(red, over(red, 0.2, popover)),
      'text-destructive/90': contrast(over(red, 0.9, bg), bg),
    });
  });

  it('dark: a SOLID red fill cannot hold a white label, which is why fills are dimmed', () => {
    // Proves the premise of the source guard below. If this ever passes, the
    // dark token has moved toward fills and the text assertions above are what
    // will have given way.
    expect(contrast(WHITE, hsl(dark, '--destructive'))).toBeLessThan(AA);
  });

  it('dark: the label clears AA on the dimmed `dark:bg-destructive/60` fill over every surface', () => {
    const red = hsl(dark, '--destructive');
    const label = hsl(dark, '--destructive-foreground');
    const grounds = ['--background', '--card', '--popover', '--muted', '--sidebar'];
    const pairs: Record<string, number> = {};
    for (const ground of grounds) {
      const fill = over(red, 0.6, hsl(dark, ground));
      pairs[`text-white over ${ground}`] = contrast(WHITE, fill);
      pairs[`text-destructive-foreground over ${ground}`] = contrast(label, fill);
    }
    expectAll(pairs);
  });

  // --- The Obsidian embed's flat literals ---

  it('Obsidian: the light red holds text and a white label; the dark-vault red holds text', () => {
    const obsidian = section(css, '.copilot-view-content {', '\n}');
    const lightPin = obsidian.match(/--color-destructive:\s*(#[0-9a-fA-F]{6})/);
    const darkPin = css.match(
      /\.theme-dark \.copilot-view-content\s*\{[^}]*--color-destructive:\s*(#[0-9a-fA-F]{6})/
    );
    expect(lightPin, 'Obsidian --color-destructive pin not found').not.toBeNull();
    expect(darkPin, 'Obsidian .theme-dark --color-destructive pin not found').not.toBeNull();
    const lightRed = hexToRgb(lightPin![1]!);
    const darkRed = hexToRgb(darkPin![1]!);
    // Obsidian's default theme surfaces: #ffffff / #f6f6f6 light, #1e1e1e / #262626 dark.
    expectAll({
      'light red on #ffffff': contrast(lightRed, hexToRgb('#ffffff')),
      'light red on #f6f6f6': contrast(lightRed, hexToRgb('#f6f6f6')),
      'white on light red': contrast(WHITE, lightRed),
      'dark red on #1e1e1e': contrast(darkRed, hexToRgb('#1e1e1e')),
      'dark red on #262626': contrast(darkRed, hexToRgb('#262626')),
    });
  });
});

/** Every `.ts`/`.tsx` source file under `dir`, tests excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe('solid destructive fills dim themselves in dark mode', () => {
  // Class strings are single-line string literals in this codebase. A string
  // that paints a solid red fill (`bg-destructive` with no `/alpha`) AND puts a
  // label on it must also carry the dark-mode dimming, or its label drops to
  // ~3.4:1 on a dark screen. Hover-only fills (`hover:bg-destructive/90` plus
  // `hover:text-destructive-foreground`) need the hover twin.
  const LITERAL = /(['"`])((?:(?!\1).)*?bg-destructive(?:(?!\1).)*)\1/g;
  const LABEL = /(^|\s)(hover:)?text-(white|destructive-foreground)(\s|$)/;

  const offenders: string[] = [];
  let inspected = 0;
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(LITERAL)) {
      const classes = m[2]!;
      if (!LABEL.test(classes)) continue;
      inspected++;
      const solid = /(^|\s)bg-destructive(\s|$)/.test(classes);
      const hoverSolid = /(^|\s)hover:bg-destructive\/(9\d|100)(\s|$)/.test(classes);
      const where = `${relative(SRC, file)}: ${classes.slice(0, 80)}`;
      if (solid && !/(^|\s)dark:bg-destructive\/60(\s|$)/.test(classes)) offenders.push(where);
      else if (!solid && hoverSolid && !/(^|\s)dark:hover:bg-destructive\/60(\s|$)/.test(classes)) {
        offenders.push(where);
      }
    }
  }

  it('finds the fills it is guarding (the scan is not vacuous)', () => {
    // button.tsx, badge.tsx, the dialogs and the composer's Stop button.
    expect(inspected).toBeGreaterThanOrEqual(10);
  });

  it('every labelled solid fill carries `dark:bg-destructive/60`', () => {
    expect(offenders).toEqual([]);
  });
});
