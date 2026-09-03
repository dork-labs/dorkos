import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Read the app's single CSS entry point straight from disk. The Radix/shadcn
// surfaces (sheet, dialog, popover, dropdown-menu, context-menu, select,
// tooltip, hover-card, alert-dialog) all style their enter/exit with
// `data-[state=open]:animate-in`, `slide-in-from-*`, `fade-*`, `zoom-*`. Those
// utilities are NOT part of core Tailwind — they come from `tw-animate-css`.
// Without the import they resolve to nothing and every one of those surfaces
// pops instead of animating. This guards the import against silent removal.
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
  it('imports tw-animate-css so data-[state] animation utilities resolve', () => {
    expect(indexCss).toMatch(/@import\s+['"]tw-animate-css['"]/);
  });

  it('imports tw-animate-css after tailwindcss so its @utility rules land in the utilities layer', () => {
    const tailwindIndex = indexCss.indexOf("@import 'tailwindcss'");
    const animateIndex = indexCss.search(/@import\s+['"]tw-animate-css['"]/);
    expect(tailwindIndex).toBeGreaterThanOrEqual(0);
    expect(animateIndex).toBeGreaterThan(tailwindIndex);
  });

  it('defines the collapsible keyframes the Collapsible primitive wears', () => {
    // This repo has shipped a class name whose keyframe did not exist twice
    // (`animate-tasks` for months, and `animations.md` pointed at accordion
    // keyframes that were never written) — a dead animation looks exactly like
    // a working one in a diff. `shared/ui/collapsible.tsx` wears both of these.
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

  it('leaves the blintz cascade-layer pin intact', () => {
    // tw-animate-css must not disturb the layer order that keeps blintz below
    // utilities (PR #311) — its utilities ride the `utilities` layer above blintz.
    expect(indexCss).toMatch(/@layer\s+theme,\s*base,\s*components,\s*blintz,\s*utilities;/);
  });
});
