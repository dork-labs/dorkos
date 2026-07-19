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

  it('leaves the blintz cascade-layer pin intact', () => {
    // tw-animate-css must not disturb the layer order that keeps blintz below
    // utilities (PR #311) — its utilities ride the `utilities` layer above blintz.
    expect(indexCss).toMatch(/@layer\s+theme,\s*base,\s*components,\s*blintz,\s*utilities;/);
  });
});
