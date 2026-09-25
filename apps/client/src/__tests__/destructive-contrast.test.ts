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
 * the PR. What a unit test CAN own is the token: the value shipped by the public UI package and bridged by
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
const UI_ROOT = resolve(SRC, '../../../packages/ui');
const UI_SRC = join(UI_ROOT, 'src');

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

/** Resolve the client's shared aliases against the matching package theme. */
function resolveSharedTokens(clientCss: string, paletteCss: string): string {
  return clientCss.replace(/var\((--dui-[a-z-]+)\)/g, (_, name: string) => {
    const declaration = paletteCss.match(new RegExp(`${name}:\\s*([^;]+);`));
    expect(declaration, `shared token not found: ${name}`).not.toBeNull();
    return declaration![1]!.trim();
  });
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
  const tokens = readFileSync(join(UI_ROOT, 'tokens.css'), 'utf8');
  const light = resolveSharedTokens(
    section(css, ':root,', '.dark {'),
    section(tokens, ':root,', '@media')
  );
  const dark = resolveSharedTokens(
    section(css, '.dark {', '@layer border-defaults'),
    section(tokens, '\n.dark {', '\n}')
  );

  it('checks the package palette that the client actually consumes', () => {
    // Copying literals back into the app would split ownership and bypass the package proof.
    expect(css.match(/--destructive:\s*var\(--dui-destructive\)/g)).toHaveLength(2);
  });

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

/** A string literal found in source: its text and where it starts and ends. */
interface Literal {
  text: string;
  start: number;
  end: number;
}

/**
 * Every string literal in `src`: single, double and template quotes, template
 * literals across lines included. Comments are skipped so prose that names a
 * class is not read as markup. A `${…}` inside a template is kept as text,
 * which is enough here: the guard only asks which class tokens a literal holds.
 */
function stringLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out.push({ text: src.slice(i + 1, j), start: i, end: j + 1 });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Calls whose arguments merge into ONE element's class list. */
const MERGE_CALL = /\b(cn|clsx|cx|twMerge|cva)\s*\($/;

/**
 * The span of source that becomes one element's classes around `lit`.
 *
 * A literal inside `cn(…)`, `clsx(…)` or `cva(…)` merges with its sibling
 * arguments, so the unit is the whole call (the outermost merge call, so a
 * nested `cn` inside a `cva` still counts as one). A literal outside any merge
 * call stands alone. The walk counts brackets backwards from the literal and
 * ignores brackets inside other literals.
 */
function classUnit(src: string, lit: Literal, literals: Literal[]): string {
  const inLiteral = (pos: number) => literals.some((l) => pos >= l.start && pos < l.end);
  let unit: [number, number] | null = null;
  let depth = 0;
  for (let p = lit.start - 1; p >= 0; p--) {
    if (inLiteral(p)) continue;
    const ch = src[p];
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (ch === '(' && MERGE_CALL.test(src.slice(Math.max(0, p - 12), p + 1))) {
        // Find this call's closing paren, then keep walking for an outer one.
        let d = 0;
        let q = p;
        for (; q < src.length; q++) {
          if (inLiteral(q)) continue;
          if (src[q] === '(') d++;
          else if (src[q] === ')' && --d === 0) break;
        }
        unit = [p, q + 1];
      }
      // Keep climbing past any other opener: the OUTERMOST merge call wins.
    }
  }
  return unit ? src.slice(unit[0], unit[1]) : lit.text;
}

/** A class token the label on a red fill is painted with. */
const LABEL = /(^|[\s'"`])(hover:)?text-(white|(?:dui-)?destructive-foreground)(?=[\s'"`]|$)/;
/** A solid (un-alpha'd) destructive fill. */
const SOLID = /(^|[\s'"`])bg-(?:dui-)?destructive(?=[\s'"`]|$)/;
/** A hover-only near-solid fill. */
const HOVER_SOLID = /(^|[\s'"`])hover:bg-(?:dui-)?destructive\/(9\d|100)(?=[\s'"`]|$)/;
const DIMMED = /(^|[\s'"`])dark:bg-destructive\/60(?=[\s'"`]|$)/;
const PACKAGE_DIMMED = /(^|[\s'"`])dui-dark:bg-dui-destructive\/60(?=[\s'"`]|$)/;
const HOVER_DIMMED = /(^|[\s'"`])dark:hover:bg-destructive\/60(?=[\s'"`]|$)/;
const PACKAGE_HOVER_DIMMED = /(^|[\s'"`])dui-dark:hover:bg-dui-destructive\/60(?=[\s'"`]|$)/;

/**
 * The labelled red fills in `src` that skip the dark-mode dimming.
 *
 * The unit judged is everything that becomes ONE element's classes: a lone
 * literal (single- or multi-line), or a whole `cn`/`clsx`/`cva` call, so a fill
 * in one argument and its label in the next is caught. It also returns how
 * many labelled fills it inspected, so a scan that finds nothing can be told
 * apart from a clean one.
 */
function undimmedFills(src: string): { offenders: string[]; inspected: number } {
  const literals = stringLiterals(src);
  const seen = new Set<string>();
  const offenders: string[] = [];
  let inspected = 0;
  for (const lit of literals) {
    if (!SOLID.test(lit.text) && !HOVER_SOLID.test(lit.text)) continue;
    const unit = classUnit(src, lit, literals);
    if (seen.has(unit)) continue;
    seen.add(unit);
    if (!LABEL.test(unit)) continue;
    inspected++;
    const solid = SOLID.test(unit);
    const packageFill = lit.text.includes('bg-dui-destructive');
    const dimmed = packageFill ? PACKAGE_DIMMED : DIMMED;
    const hoverDimmed = packageFill ? PACKAGE_HOVER_DIMMED : HOVER_DIMMED;
    if ((solid && !dimmed.test(unit)) || (!solid && !hoverDimmed.test(unit))) {
      offenders.push(unit.replace(/\s+/g, ' ').slice(0, 100));
    }
  }
  return { offenders, inspected };
}

describe('solid destructive fills dim themselves in dark mode', () => {
  // A labelled solid red fill must carry `dark:bg-destructive/60`, or its label
  // drops to ~3.4:1 on a dark screen. A hover-only fill needs the hover twin.

  it('catches a fill and its label split across cn() arguments', () => {
    const src = `const c = cn('bg-destructive rounded-md', 'text-destructive-foreground px-3');`;
    expect(undimmedFills(src).offenders).toHaveLength(1);
    expect(undimmedFills(src.replace('rounded-md', 'rounded-md dark:bg-destructive/60'))).toEqual({
      offenders: [],
      inspected: 1,
    });
  });

  it('catches a fill and its label split across clsx() lines and nested calls', () => {
    const src = [
      'const c = clsx(',
      "  'inline-flex',",
      "  confirming && cn('bg-destructive', 'hover:bg-destructive/90'),",
      "  'text-white',",
      ');',
    ].join('\n');
    expect(undimmedFills(src).offenders).toHaveLength(1);
  });

  it('catches a multi-line template literal', () => {
    const src = 'const c = `\n  bg-destructive\n  text-white\n`;';
    expect(undimmedFills(src).offenders).toHaveLength(1);
  });

  it('catches a hover-only fill without the hover twin', () => {
    const src = `x = 'bg-muted hover:bg-destructive/90 hover:text-destructive-foreground';`;
    expect(undimmedFills(src).offenders).toHaveLength(1);
    expect(
      undimmedFills(src.replace("foreground'", "foreground dark:hover:bg-destructive/60'"))
        .offenders
    ).toEqual([]);
  });

  it('leaves unlabelled fills, tints and comments alone', () => {
    const src = [
      "const swatch = { bg: 'bg-destructive' };",
      "const chip = 'bg-destructive/10 text-destructive';",
      '// bg-destructive text-white in prose is not markup',
    ].join('\n');
    expect(undimmedFills(src)).toEqual({ offenders: [], inspected: 0 });
  });

  it('catches namespaced package fills without their matching dark variant', () => {
    const src = `x = 'bg-dui-destructive text-dui-destructive-foreground';`;
    expect(undimmedFills(src).offenders).toHaveLength(1);
    expect(
      undimmedFills(src.replace("foreground'", "foreground dui-dark:bg-dui-destructive/60'"))
    ).toEqual({
      offenders: [],
      inspected: 1,
    });
    expect(
      undimmedFills(src.replace("foreground'", "foreground dark:bg-dui-destructive/60'")).offenders
    ).toHaveLength(1);
    const button = undimmedFills(readFileSync(join(UI_SRC, 'button.tsx'), 'utf8'));
    expect(button.inspected).toBe(1);
    expect(button.offenders).toEqual([]);
  });

  it('every labelled solid fill in the app and package carries the dark dimming', () => {
    const offenders: string[] = [];
    let inspected = 0;
    for (const file of [...sourceFiles(SRC), ...sourceFiles(UI_SRC)]) {
      const result = undimmedFills(readFileSync(file, 'utf8'));
      inspected += result.inspected;
      offenders.push(...result.offenders.map((o) => `${relative(SRC, file)}: ${o}`));
    }
    // button.tsx, badge.tsx, the dialogs and the composer's Stop button: a scan
    // that inspected none of them would pass while guarding nothing.
    expect(inspected).toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });
});
