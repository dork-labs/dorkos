import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

// The client imports one package-owned animation entry after Tailwind. Following
// that boundary protects real utilities without demanding duplicate imports.
const uiRoot = dirname(createRequire(import.meta.url).resolve('@dork-labs/ui/package.json'));
const sharedCss = readFileSync(resolve(uiRoot, 'tailwind.css'), 'utf8');
const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8'
);

// The package's own shipped stylesheet, not a hand-copy of it, so a version
// bump that renames or drops a keyframe fails this test instead of failing
// silently in the browser. `tw-animate-css`'s `exports` map only advertises a
// `style` condition (no `import`/`require`/`default`), which Node's `resolve`
// won't follow, so this reaches the file the same way `apps/client`'s own
// `package.json` dependency does: through its own `node_modules`.
const twAnimateCss = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../node_modules/tw-animate-css/dist/tw-animate.css'
  ),
  'utf8'
);

describe('animation utilities wiring (index.css)', () => {
  it('loads animation utilities once through the shared package entry', () => {
    expect(indexCss).toMatch(/@import\s+['"]@dork-labs\/ui\/tailwind.css['"]/);
    expect(indexCss).not.toMatch(/@import\s+['"]tw-animate-css['"]/);
    expect(sharedCss.match(/@import\s+['"]tw-animate-css['"]/g)).toHaveLength(1);
  });

  it('loads shared animation utilities after Tailwind without changing its layer', () => {
    const tailwindIndex = indexCss.indexOf("@import 'tailwindcss'");
    const sharedIndex = indexCss.search(/@import\s+['"]@dork-labs\/ui\/tailwind.css['"]/);
    expect(tailwindIndex).toBeGreaterThanOrEqual(0);
    expect(sharedIndex).toBeGreaterThan(tailwindIndex);
  });

  it('defines the collapsible keyframes the Collapsible primitive wears', () => {
    // This repo has shipped a class name whose keyframe did not exist twice
    // (`animate-tasks` for months, and `animations.md` pointed at accordion
    // keyframes that were never written) — a dead animation looks exactly like
    // a working one in a diff. the shared Collapsible implementation wears both of these.
    // The keyframes live in `tw-animate-css`, not `index.css` (DOR-1751): a
    // hand-written duplicate shipped here once, and — measured against the
    // compiled stylesheet — the library's rule is the one that actually wins,
    // making the duplicate dead CSS. Asserting against `index.css` again would
    // just pin that mistake back in place.
    for (const name of ['collapsible-down', 'collapsible-up']) {
      expect(twAnimateCss).toMatch(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
      expect(twAnimateCss).toMatch(new RegExp(`--animate-${name}:`));
    }
    // The height the keyframes grow to is Radix's own measurement, not a guess.
    expect(twAnimateCss).toContain('--radix-collapsible-content-height');
  });

  it('does not redeclare the collapsible keyframes in index.css', () => {
    // The hand-written duplicate this test used to pin in place (DOR-1751):
    // `tw-animate-css` already owns `collapsible-down` / `collapsible-up`, so a
    // second declaration here is dead CSS that loses the cascade and misleads
    // the next reader into thinking `index.css` is the source of truth.
    for (const name of ['collapsible-down', 'collapsible-up']) {
      expect(indexCss).not.toMatch(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
      expect(indexCss).not.toMatch(new RegExp(`@utility\\s+animate-${name}\\s*\\{`));
    }
  });

  it('resolves every animation/animation-name value in index.css to a declared @keyframes', () => {
    // A rename that touches the `@keyframes` declaration but misses a
    // consumer is invisible everywhere else: nothing errors, the browser
    // just silently drops the animation (an unresolved animation-name is not
    // a CSS error, per spec). That is exactly how the `tasks` → `breath`
    // rename left the reduced-motion fallback pointed at a keyframe that no
    // longer existed. This walks every `animation:`/`animation-name:` value
    // in the file and asserts the name it references is declared somewhere
    // — either here or in `tw-animate-css`.
    const declared = new Set<string>();
    for (const css of [indexCss, twAnimateCss]) {
      for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
        declared.add(m[1]);
      }
    }
    const nonNameKeywords = new Set(['none', 'initial', 'inherit', 'unset', 'revert']);
    // Split on commas that separate multiple animations, not the commas
    // inside a `cubic-bezier(...)` argument list.
    const splitTopLevel = (value: string): string[] => {
      const parts: string[] = [];
      let depth = 0;
      let current = '';
      for (const char of value) {
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (char === ',' && depth === 0) {
          parts.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      parts.push(current);
      return parts;
    };
    const referenced = new Set<string>();
    for (const m of indexCss.matchAll(/animation-name:\s*([^;]+);/g)) {
      for (const segment of splitTopLevel(m[1])) {
        const name = segment.trim();
        if (name && !nonNameKeywords.has(name)) referenced.add(name);
      }
    }
    // The `animation` shorthand puts the keyframe name first in every rule
    // this file writes; grab it (and skip `animation: none;`).
    for (const m of indexCss.matchAll(/[^-\w]animation:\s*([^;]+);/g)) {
      for (const segment of splitTopLevel(m[1])) {
        const name = segment.trim().split(/\s+/)[0];
        if (name && !nonNameKeywords.has(name)) referenced.add(name);
      }
    }
    expect(referenced.size).toBeGreaterThan(10);
    const unresolved = [...referenced].filter((name) => !declared.has(name));
    expect(unresolved).toEqual([]);
  });

  it('leaves the blintz cascade-layer pin intact', () => {
    // tw-animate-css must not disturb the layer order that keeps blintz below
    // utilities (PR #311) — its utilities ride the `utilities` layer above blintz.
    // `border-defaults` sits between the two (DOR-1024); the order of everything
    // else, and blintz's position under `utilities`, is what this pins.
    expect(indexCss).toMatch(
      /@layer\s+theme,\s*base,\s*components,\s*blintz,\s*border-defaults,\s*utilities;/
    );
  });
});
