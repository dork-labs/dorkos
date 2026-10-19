// @vitest-environment node
/**
 * Orange TEXT clears WCAG AA (4.5:1 for normal text) on every ground it is
 * painted on, in light AND dark mode.
 *
 * The brand orange (`--brand`, which `--ring` equals) is a fill and a focus
 * ring. As text it measured 3.74:1 on the light page, 3.19:1 on the sidebar,
 * and 3.40:1 for a directed-unread count on its own `bg-brand/15` tint over a
 * selected sidebar row (style-guide audit, 2026-10-17). `--brand-text` is the
 * orange for words: message links and inline code (`.msg-prose`), the unread
 * divider, the unread count badges, a selected answer mode. Same hue, moved in
 * lightness only.
 *
 * **The badges decide the light value.** A count badge paints `--brand-text`
 * on `bg-brand/15` over the sidebar, a hovered row and a selected row. The
 * audit's suggested `36%` clears the page (5.25:1) but not the plain sidebar
 * (4.48:1) or those tints (3.40-3.78:1), so the token sits at `29%`.
 *
 * **Contrast needs layout, and jsdom has none.** What a unit test CAN own is
 * the token: the value the UI package ships and `index.css` bridges, run
 * through the WCAG math against the ground it sits on. The math is pinned
 * against known pairs first, and the discriminator is proven both ways (the
 * old ring-as-text colour fails, the shipped token passes), so a contrast
 * function that returned a constant cannot make the real assertions pass.
 *
 * @module __tests__/brand-text-contrast
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const UI_ROOT = resolve(SRC, '../../../packages/ui');

/** WCAG AA threshold for normal-size text. */
const AA = 4.5;

type Rgb = readonly [number, number, number];

/** An `H S% L%` triplet (the shape CSS custom properties store) to sRGB 0-255. */
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

/** Composite `fg` at `alpha` over an opaque `bg`, as the browser paints a `bg-brand/15` tint. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb;
}

/** The stretch of a stylesheet between two markers, where one token block lives. */
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

/** Assert every `[label, ratio]` clears AA, naming every failure at once. */
function expectAll(pairs: Record<string, number>): void {
  const failing = Object.entries(pairs)
    .filter(([, ratio]) => ratio < AA)
    .map(([name, ratio]) => `${name}: ${ratio.toFixed(2)}:1`);
  expect(failing).toEqual([]);
}

const css = readFileSync(join(SRC, 'index.css'), 'utf8');
const tokens = readFileSync(join(UI_ROOT, 'tokens.css'), 'utf8');
const themes = {
  light: resolveSharedTokens(
    section(css, ':root,', '.dark {'),
    section(tokens, ':root,', '@media')
  ),
  dark: resolveSharedTokens(
    section(css, '.dark {', '@layer border-defaults'),
    section(tokens, '\n.dark {', '\n}')
  ),
};

/** Every ground orange text sits on, in one theme. */
function grounds(theme: string): Record<string, Rgb> {
  const brand = hsl(theme, '--brand');
  const sidebar = hsl(theme, '--sidebar');
  const sidebarAccent = hsl(theme, '--sidebar-accent');
  const rowHover = over(sidebarAccent, 0.7, sidebar);
  const popover = hsl(theme, '--popover');
  const accent = hsl(theme, '--accent');
  const bg = hsl(theme, '--background');
  return {
    background: bg,
    card: hsl(theme, '--card'),
    popover,
    // Inline code paints on `bg-muted`.
    muted: hsl(theme, '--muted'),
    'accent (hovered menu row)': accent,
    secondary: hsl(theme, '--secondary'),
    sidebar,
    'sidebar row hover (bg-sidebar-accent/70)': rowHover,
    'sidebar row selected (bg-sidebar-accent)': sidebarAccent,
    'count badge (bg-brand/15) on the sidebar': over(brand, 0.15, sidebar),
    'count badge on a hovered sidebar row': over(brand, 0.15, rowHover),
    'count badge on a selected sidebar row': over(brand, 0.15, sidebarAccent),
    'count badge on a popover': over(brand, 0.15, popover),
    'count badge on a highlighted palette item': over(brand, 0.15, accent),
    'selected answer mode (bg-brand/10 on a popover)': over(brand, 0.1, popover),
    'loudness preview (bg-brand/5 on the page)': over(brand, 0.05, bg),
  };
}

function ratios(theme: string, text: Rgb): Record<string, number> {
  return Object.fromEntries(
    Object.entries(grounds(theme)).map(([name, ground]) => [name, contrast(text, ground)])
  );
}

describe('brand text contrast', () => {
  it('checks the package palette the client actually consumes', () => {
    // Copying a literal back into the app would split ownership and bypass this proof.
    expect(css.match(/--brand-text:\s*var\(--dui-brand-text\)/g)).toHaveLength(2);
    expect(css).toMatch(/--color-brand-text:\s*hsl\(var\(--brand-text\)\)/);
    // The system-dark block and the `.dark` class carry the same value.
    const darkValues = [...tokens.matchAll(/--dui-brand-text:\s*([^;]+);/g)].map((m) => m[1]);
    expect(darkValues).toHaveLength(3);
    expect(darkValues[1]).toBe(darkValues[2]);
  });

  it('computes known contrast pairs correctly', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
    expect(contrast([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    expect(hslToRgb(24, 90, 44).map(Math.round)).toEqual([213, 92, 11]);
  });

  it('discriminates: the brand fill FAILS as text, the shipped token PASSES', () => {
    const bg = hsl(themes.light, '--background');
    expect(contrast(hsl(themes.light, '--brand'), bg)).toBeLessThan(AA);
    expect(contrast(hsl(themes.light, '--ring'), bg)).toBeLessThan(AA);
    // The audit's first guess clears the page and still fails the sidebar badge.
    expect(
      ratios(themes.light, hslToRgb(24, 90, 36))['count badge (bg-brand/15) on the sidebar']
    ).toBeLessThan(AA);
    expect(contrast(hsl(themes.light, '--brand-text'), bg)).toBeGreaterThanOrEqual(AA);
  });

  it('light: brand text clears AA on every ground', () => {
    expectAll(ratios(themes.light, hsl(themes.light, '--brand-text')));
  });

  it('dark: brand text clears AA on every ground', () => {
    expectAll(ratios(themes.dark, hsl(themes.dark, '--brand-text')));
  });

  it('message links and inline code paint with the text token, not the ring', () => {
    const link = section(css, '.msg-prose a,', '}');
    const code = section(css, '.msg-prose code {', '}');
    expect(link).toContain('color: hsl(var(--brand-text))');
    expect(code).toContain('color: hsl(var(--brand-text))');
  });
});
