/**
 * The first test in this package, and the first one anywhere that reads the
 * plugin's BUILT stylesheet.
 *
 * **Source-level assertions cannot catch what this catches.** The plugin is its
 * own Tailwind compile: a colour the client writes utilities against but this
 * build never declares is not an error anywhere — the utility is simply not
 * emitted, the class is dead markup, and the element renders correctly sized,
 * correctly animated and completely invisible. That is not hypothetical. It
 * shipped twice on one branch: `bg-sidebar-accent` (a promo card with no fill),
 * and then `bg-status-*` (a status dot with no colour), the second one INSIDE a
 * change whose whole subject was the first. Nothing in TypeScript, ESLint or the
 * component tests can see it, because every one of them stops at the class
 * string.
 *
 * So the artifact is the witness. `pnpm --filter @dorkos/obsidian-plugin test`
 * builds before it asserts; a run that finds no `dist/styles.css` fails loudly
 * rather than skipping, because a guard that passes when it cannot see anything
 * is worse than no guard at all.
 *
 * @module obsidian-plugin/__tests__/plugin-styles
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATUS_DOT_COLOR,
  STATUS_TONE_TEXT,
} from '../../../client/src/layers/shared/ui/status-dot';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../..');

const PLUGIN_CSS = fs.readFileSync(path.join(PLUGIN_ROOT, 'src/styles/plugin.css'), 'utf8');
const CLIENT_CSS = fs.readFileSync(path.join(REPO_ROOT, 'apps/client/src/index.css'), 'utf8');

/**
 * The built stylesheet, or a failure that names the fix.
 *
 * Deliberately NOT a skip. The whole value of this file is that it reads the
 * artifact, so "no artifact" is the one state it must never treat as fine.
 */
function builtStylesheet(): string {
  const file = path.join(PLUGIN_ROOT, 'dist/styles.css');
  if (!fs.existsSync(file)) {
    throw new Error(
      `No built stylesheet at ${file}. This suite asserts on the BUILD OUTPUT, so it ` +
        'cannot run without one. Use the package test script, which builds first: ' +
        '`pnpm --filter @dorkos/obsidian-plugin test`.'
    );
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * The `--color-*` names declared inside a `@theme` block.
 *
 * Scoped to that block on purpose: both files also declare `--color-*` inside
 * `.copilot-view-content`, and those are VALUES for the theme, not new colours.
 * Counting them would make the two sides agree for the wrong reason.
 *
 * @param css - The stylesheet source.
 */
function themeColorTokens(css: string): string[] {
  const start = css.indexOf('@theme');
  if (start === -1) return [];
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = css.slice(open, end);
  return [...block.matchAll(/^\s*(--color-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!).sort();
}

/** Every custom property given a value inside `.copilot-view-content`. */
function bridgedValues(css: string): Set<string> {
  const names = new Set<string>();
  for (const m of css.matchAll(/\.copilot-view-content\s*\{([\s\S]*?)\n\}/g)) {
    for (const d of m[1]!.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) names.add(d[1]!);
  }
  return names;
}

/**
 * The literal value the FIRST declaration of `prop` is given.
 *
 * The trailing negative lookahead keeps `--status-success` from matching
 * `--status-success-bg` — a prefix collision that would compare the wrong two
 * values and call a drift a match.
 *
 * @param css - The stylesheet source (scope it first if the name repeats).
 * @param prop - The custom-property name, e.g. `--status-success`.
 */
function tokenValue(css: string, prop: string): string | undefined {
  const m = css.match(new RegExp(`${prop}(?![a-z-])\\s*:\\s*([^;]+);`));
  return m ? m[1]!.trim() : undefined;
}

/**
 * The `.copilot-view-content` block(s), concatenated.
 *
 * The client declares `--color-status-success` TWICE — once in `@theme` as
 * `hsl(var(--status-success))`, once here as the Obsidian literal — so reading
 * the whole file would pick up the theme mapping instead of the pin. Scope
 * first, then read.
 *
 * @param css - The stylesheet source.
 */
function copilotBlock(css: string): string {
  return [...css.matchAll(/\.copilot-view-content\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1]!)
    .join('\n');
}

/**
 * Utility class names present in the built stylesheet.
 *
 * Read off selector heads rather than by substring search: `bg-status-success`
 * appears inside `bg-status-success-bg` too, and a substring match would call a
 * missing colour present because a neighbouring one exists.
 *
 * **`{` counts as a delimiter, and that is not cosmetic.** Half of what this
 * file asks about lives inside an at-rule — `motion-safe:` compiles to a
 * `@media (prefers-reduced-motion: no-preference)` wrapper — so a scan that only
 * resumed after `}` or `;` never saw those selectors at all and reported the
 * dot's pulse missing when it was there.
 *
 * @param css - The built stylesheet.
 */
function emittedUtilities(css: string): Set<string> {
  const names = new Set<string>();
  for (const m of css.matchAll(/(^|[{};])\s*([^{}@][^{}]*?)\{/g)) {
    for (const sel of m[2]!.split(',')) {
      const t = sel.trim();
      if (!t.startsWith('.')) continue;
      const name = t.match(/^\.((?:\\.|[^\\.:>~+\s[])+)/);
      if (name) names.add(name[1]!.replace(/\\/g, ''));
    }
  }
  return names;
}

describe('the plugin bridges the client’s colour family', () => {
  it('declares every `--color-*` the client’s theme declares', () => {
    const client = themeColorTokens(CLIENT_CSS);
    const plugin = themeColorTokens(PLUGIN_CSS);

    expect(client.length).toBeGreaterThan(50);
    // Named individually rather than as a set difference: the failure message is
    // the whole point, and "missing: --color-status-warning-dot" is a fix.
    const missing = client.filter((t) => !plugin.includes(t));
    expect(missing).toEqual([]);
  });

  it('gives every bridged colour an actual value in the Obsidian block', () => {
    // A `--color-x: var(--x)` whose `--x` nothing sets resolves to nothing, which
    // is the same invisible element by a different route.
    const values = bridgedValues(PLUGIN_CSS);
    const unmapped = themeColorTokens(PLUGIN_CSS)
      .map((token) => token.replace(/^--color-/, '--'))
      .filter((source) => !values.has(source));
    expect(unmapped).toEqual([]);
  });

  it('pins the Obsidian success green to the SAME literals the client uses (DOR-1080)', () => {
    // Two byte-identical copies of the flat green: the client writes it as
    // `--color-status-success` in its `.copilot-view-content` block, this plugin
    // writes the raw `--status-success` its own Tailwind reads. They MUST match —
    // the plugin's built sheet is what paints the embedded sidebar (the "Working"
    // dot on SessionRowSidebar). A WCAG-AA fix applied to one and not the other
    // ships the failing colour anyway; this is the guard that catches that drift.
    //
    // Positive-anchored to a concrete value so a regex that returns `undefined`
    // fails here rather than passing on `undefined === undefined`. The AA math
    // itself is owned by the client's `status-success-contrast` guard, which
    // asserts this same literal clears 4.5:1 on white; matching it transitively
    // makes the plugin's green pass too.
    const clientObsidian = copilotBlock(CLIENT_CSS);
    const pairs: [clientProp: string, pluginProp: string][] = [
      ['--color-status-success', '--status-success'],
      ['--color-status-success-bg', '--status-success-bg'],
      ['--color-status-success-border', '--status-success-border'],
      ['--color-status-success-fg', '--status-success-fg'],
    ];
    expect(tokenValue(clientObsidian, '--color-status-success')).toBe('#15803d');
    expect(tokenValue(PLUGIN_CSS, '--status-success')).toBe('#15803d');
    for (const [clientProp, pluginProp] of pairs) {
      const client = tokenValue(clientObsidian, clientProp);
      const plugin = tokenValue(PLUGIN_CSS, pluginProp);
      expect({ token: pluginProp, client, plugin }).toEqual({
        token: pluginProp,
        client,
        plugin: client,
      });
    }
  });

  it("declares `--size-icon-*`, so `button.tsx`'s default icon size resolves (DOR-1750)", () => {
    // button.tsx's base class is `[&_svg:not([class*='size-'])]:size-(--size-icon-sm)`
    // — the default size for every unsized svg a `<Button>` renders, and
    // `button.tsx` is on this file's `@source` list. An undeclared custom
    // property makes `width`/`height` invalid at computed-value time, so the
    // rule is emitted but resolves to nothing and a lucide icon falls back to
    // its intrinsic 24px instead of the intended 16.
    for (const token of ['--size-icon-xs', '--size-icon-sm', '--size-icon-md']) {
      expect(tokenValue(PLUGIN_CSS, token)).toBeTruthy();
    }
  });

  it("gives `--chart-*` the client's bare-triple shape, not a wrapped hsl() (DOR-1750)", () => {
    // `TASK_COLORS` (use-background-tasks.ts) and `CHART_COLORS` (ChartNode.tsx)
    // both write `hsl(var(--chart-N))` as an INLINE STYLE, so no Tailwind
    // emission rescues a mismatch. If `--chart-N` here were a complete
    // `hsl(...)` colour, that inline style would nest `hsl(hsl(...))` — invalid,
    // and it resolves to transparent rather than a colour.
    for (let n = 1; n <= 5; n++) {
      const client = tokenValue(CLIENT_CSS, `--chart-${n}`);
      const plugin = tokenValue(PLUGIN_CSS, `--chart-${n}`);
      expect(plugin).not.toMatch(/^hsl\(/);
      expect({ chart: n, client, plugin }).toEqual({ chart: n, client, plugin: client });
    }
  });
});

describe('the built stylesheet', () => {
  it('emits a colour for every status signal the dot vocabulary defines', () => {
    const emitted = emittedUtilities(builtStylesheet());

    // Driven off `STATUS_DOT_COLOR` itself, so a fifth signal added there fails
    // here until `plugin.css`'s `@source inline(...)` answers for it. A literal
    // list would have gone stale silently, which is the drift the safelist in
    // that file would otherwise invite.
    const missing = Object.values(STATUS_DOT_COLOR).filter((c) => !emitted.has(c));
    expect(missing).toEqual([]);
  });

  it('emits a text colour for every status tone the shared vocabulary defines', () => {
    const emitted = emittedUtilities(builtStylesheet());

    // Driven off `STATUS_TONE_TEXT` itself, so a tone added there fails here
    // until `plugin.css`'s text-tone `@source inline(...)` answers for it — the
    // same discipline `STATUS_DOT_COLOR` gets above. `SessionContextGauge`
    // reaches these through the shared module rather than a literal class
    // string, so this build's own scanner has nothing else to find them by.
    const missing = Object.values(STATUS_TONE_TEXT)
      .filter((c) => c.startsWith('text-status-'))
      .filter((c) => !emitted.has(c));
    expect(missing).toEqual([]);
  });

  it('emits the one motion the dot vocabulary spends', () => {
    // `statusDotClass('working')` returns the colour AND this. Without it the
    // dot is the right colour and permanently still, which reads as "idle".
    expect(emittedUtilities(builtStylesheet())).toContain('motion-safe:animate-pulse');
  });

  it('never emits a utility that escapes the Obsidian leaf', () => {
    const emitted = emittedUtilities(builtStylesheet());

    // `position: fixed` inside a leaf pane is positioned against the WINDOW, so
    // a scrim wearing these paints over the user's whole vault — including the
    // notes either side of the panel. The `@source` list in `plugin.css` is
    // scoped to the roster's own modules precisely so these never arrive, and
    // this is the assertion that keeps a future `@source` line honest. `absolute`
    // is deliberately absent from the list: the row's "⋮" is positioned against
    // its own row, which is what `absolute` is for.
    for (const escape of ['fixed', 'inset-0', 'z-50', 'bg-black/80']) {
      expect(emitted).not.toContain(escape);
    }
  });
});
