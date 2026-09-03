import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The app's default border colour has to sit INSIDE a cascade layer, and this
 * is the only thing that can notice when it stops.
 *
 * `index.css` paints `border-color: hsl(var(--border))` on `*` so a bare
 * `border` class draws the neutral line instead of the text colour. For a long
 * time that rule was unlayered — and per the cascade-layers spec an unlayered
 * declaration beats a layered one at ANY specificity, so this near-zero
 * specificity rule outranked every `border-<colour>` utility Tailwind emits.
 * `border-primary`, `border-destructive` and `border-transparent` all rendered
 * as the same neutral line across 69 files (DOR-1750).
 *
 * jsdom does not implement cascade layers, so no rendering test can catch a
 * regression here. Reading the stylesheet can.
 */
const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8'
);

/** The same CSS with every comment blanked out, so a `{` inside prose cannot skew the brace walk. */
const withoutComments = indexCss.replace(/\/\*[\s\S]*?\*\//g, (block) =>
  block.replace(/[^\n]/g, ' ')
);

/**
 * The cascade layers enclosing a byte offset, outermost first.
 *
 * Walks blocks from the top of the file, pushing the layer name for every
 * `@layer <name> {` opener and `null` for any other block, so a rule nested
 * inside a media query inside a layer still reports its layer.
 *
 * @param offset - Byte offset into {@link withoutComments}.
 */
function enclosingLayers(offset: number): string[] {
  const stack: (string | null)[] = [];
  let preludeStart = 0;
  for (let i = 0; i < offset; i++) {
    const ch = withoutComments[i];
    if (ch === '{') {
      const prelude = withoutComments.slice(preludeStart, i).trim();
      const named = /@layer\s+([\w-]+)\s*$/.exec(prelude);
      stack.push(named ? named[1] : null);
      preludeStart = i + 1;
    } else if (ch === '}') {
      stack.pop();
      preludeStart = i + 1;
    } else if (ch === ';') {
      preludeStart = i + 1;
    }
  }
  return stack.filter((name): name is string => name !== null);
}

describe('the default border colour (index.css)', () => {
  it('declares a neutral border colour on every element', () => {
    // Tailwind's preflight resets elements to `border: 0 solid`, leaving
    // `border-color` at `currentColor`. Without this rule a bare `border`
    // class paints the text colour.
    expect(withoutComments).toMatch(/\*:where\(:not\(\.copilot-view-content \*\)\)/);
  });

  it('keeps that rule inside @layer base, below Tailwind utilities', () => {
    const offset = withoutComments.indexOf('*:where(:not(.copilot-view-content *))');
    expect(offset).toBeGreaterThan(-1);
    expect(enclosingLayers(offset)).toContain('base');
  });

  it('pins base below utilities in the layer order', () => {
    // The rule being layered only helps if `base` is declared before
    // `utilities` — layer order is declaration order, not nesting.
    const order = /@layer\s+([^;]+);/.exec(withoutComments);
    expect(order).not.toBeNull();
    const names = order![1].split(',').map((name) => name.trim());
    expect(names.indexOf('base')).toBeLessThan(names.indexOf('utilities'));
  });
});
