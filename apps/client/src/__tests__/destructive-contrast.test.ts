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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATUS_TONE_TEXT } from '@/layers/shared/ui/status-dot';
import {
  AA,
  INDEX_CSS,
  type Rgb,
  UI_ROOT,
  WHITE,
  contrast,
  expectAll,
  hexToRgb,
  hsl,
  hslToRgb,
  over,
  resolveSharedTokens,
  section,
} from './destructive-contrast.fixtures';

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

/**
 * The token a bare text-colour class paints with (`text-destructive` →
 * `--destructive`), so the assertion follows whatever class the map holds.
 */
function textToken(cls: string): string {
  const m = cls.match(/^text-([a-z-]+)$/);
  expect(m, `not a plain text-colour class: ${cls}`).not.toBeNull();
  return `--${m![1]}`;
}

describe('bare red status text (DOR-2493)', () => {
  // `STATUS_TONE_TEXT.error` is red painted straight on grey, not on its own
  // tint: the session row's context gauge (sidebar, hovered, selected), the
  // status bar's context percent, the connection hover card, a relay
  // conversation's status word. `--status-error-fg` measured 4.08:1 on the
  // selected session row in dark mode; this fails if the map goes back to it.
  const css = readFileSync(INDEX_CSS, 'utf8');
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

  /** Every ground the bare red sits on, in one theme. */
  function grounds(theme: string): Record<string, Rgb> {
    const sidebar = hsl(theme, '--sidebar');
    const secondary = hsl(theme, '--secondary');
    const bg = hsl(theme, '--background');
    const muted = hsl(theme, '--muted');
    return {
      sidebar,
      'session row hover (bg-secondary/60 over sidebar)': over(secondary, 0.6, sidebar),
      'selected session row (bg-secondary)': secondary,
      background: bg,
      card: hsl(theme, '--card'),
      popover: hsl(theme, '--popover'),
      'relay row hover (bg-muted/50)': over(muted, 0.5, bg),
      // An out-of-usage session row wears the red tint; the gauge's red sits on it.
      'out-of-usage session row (bg-status-error-bg)': hsl(theme, '--status-error-bg'),
    };
  }

  function ratios(theme: string, cls: string): Record<string, number> {
    const red = hsl(theme, textToken(cls));
    return Object.fromEntries(
      Object.entries(grounds(theme)).map(([name, ground]) => [name, contrast(red, ground)])
    );
  }

  it('discriminates: the 60% red `-fg` used to hold fails the selected row in dark mode', () => {
    expect(contrast(hslToRgb(0, 72, 60), hsl(themes.dark, '--secondary'))).toBeLessThan(AA);
  });

  it('dark: the `-fg` red clears AA on the selected row', () => {
    expect(
      ratios(themes.dark, 'text-status-error-fg')['selected session row (bg-secondary)']
    ).toBeGreaterThanOrEqual(AA);
  });

  it('light: clears AA on every ground', () => {
    expectAll(ratios(themes.light, STATUS_TONE_TEXT.error));
  });

  it('dark: clears AA on every ground', () => {
    expectAll(ratios(themes.dark, STATUS_TONE_TEXT.error));
  });
});

describe('bare amber status text on the session row (claude-account-ui 04 §13)', () => {
  // `STATUS_TONE_TEXT.warning` is amber painted straight on grey: the session
  // row's context gauge at 80% and over, in the sidebar, on its accent
  // tint, hovered and selected. At 30% lightness the light token measured
  // 4.41:1 on the sidebar and 4.21:1 on the zone tint; this fails if it goes
  // back. Dark mode clears every ground by a wide margin.
  const css = readFileSync(INDEX_CSS, 'utf8');
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

  /** Every ground the session row's gauge sits on, in one theme. */
  function rowGrounds(theme: string): Record<string, Rgb> {
    const sidebar = hsl(theme, '--sidebar');
    const zone = over(hsl(theme, '--sidebar-accent'), 0.4, sidebar);
    const secondary = hsl(theme, '--secondary');
    return {
      sidebar,
      'sidebar accent tint (bg-sidebar-accent/40)': zone,
      'row hover over the sidebar (bg-secondary/60)': over(secondary, 0.6, sidebar),
      'row hover over the zone tint': over(secondary, 0.6, zone),
      'selected row (bg-secondary)': secondary,
      'out-of-usage row (bg-status-error-bg)': hsl(theme, '--status-error-bg'),
    };
  }

  function ratios(theme: string, amber: Rgb): Record<string, number> {
    return Object.fromEntries(
      Object.entries(rowGrounds(theme)).map(([name, ground]) => [name, contrast(amber, ground)])
    );
  }

  it('discriminates: the 30% amber it replaced fails the zone tint in light mode', () => {
    expect(
      ratios(themes.light, hslToRgb(38, 92, 30))['sidebar accent tint (bg-sidebar-accent/40)']
    ).toBeLessThan(AA);
  });

  it('light: clears AA on every row ground', () => {
    expectAll(ratios(themes.light, hsl(themes.light, textToken(STATUS_TONE_TEXT.warning))));
  });

  it('dark: clears AA on every row ground', () => {
    expectAll(ratios(themes.dark, hsl(themes.dark, textToken(STATUS_TONE_TEXT.warning))));
  });
});
