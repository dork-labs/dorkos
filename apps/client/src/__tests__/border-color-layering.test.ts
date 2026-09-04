import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The app's default border colour has to sit in ONE exact cascade layer, and
 * this is the only thing that can notice when it stops.
 *
 * `index.css` paints `border-color: hsl(var(--border))` on `*` so a bare
 * `border` class draws the neutral line instead of the text colour. Its slot
 * has two neighbours and both are load-bearing:
 *
 * - **Below `utilities`.** For a long time the rule was unlayered — and per the
 *   cascade-layers spec an unlayered declaration beats a layered one at ANY
 *   specificity, so this near-zero-specificity rule outranked every
 *   `border-<colour>` utility Tailwind emits. `border-primary`,
 *   `border-destructive` and `border-transparent` all rendered as the same
 *   neutral line across 69 files (DOR-1750).
 * - **Above `blintz`.** `blintz.css` bundles its own Tailwind preflight
 *   (`*,:after,:before{border:0 solid}`, which resets border colour to
 *   `currentColor`), it is NOT scoped to the canvas editor, and its layer sits
 *   above `base`. Parked in `base`, the default was repainted app-wide the
 *   moment the lazy canvas chunk loaded (DOR-1024).
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

/** The layer this stylesheet's border-colour defaults must live in. */
const BORDER_LAYER = 'border-defaults';

/**
 * The at-rule preludes enclosing a byte offset, outermost first.
 *
 * Walks blocks from the top of the file, pushing every block's prelude, so a
 * rule nested inside a media query inside a layer still reports its layer.
 *
 * @param offset - Byte offset into {@link withoutComments}.
 */
function enclosingAtRules(offset: number): string[] {
  const stack: string[] = [];
  let preludeStart = 0;
  for (let i = 0; i < offset; i++) {
    const ch = withoutComments[i];
    if (ch === '{') {
      stack.push(withoutComments.slice(preludeStart, i).trim().replace(/\s+/g, ' '));
      preludeStart = i + 1;
    } else if (ch === '}') {
      stack.pop();
      preludeStart = i + 1;
    } else if (ch === ';') {
      preludeStart = i + 1;
    }
  }
  return stack.filter((prelude) => prelude.startsWith('@'));
}

/** Byte offsets of every `border-color` (or per-side) declaration in the stylesheet. */
function borderColorDeclarations(): number[] {
  const offsets: number[] = [];
  const pattern = /(^|[\s;{])(border-[a-z-]*color)\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments)) !== null) {
    offsets.push(match.index + match[1].length);
  }
  return offsets;
}

/**
 * The selector of the rule containing a byte offset.
 *
 * Walks back to the `{` that opens the enclosing block, then back again to
 * whatever ended the previous statement, which is where the prelude starts.
 *
 * @param offset - Byte offset into {@link withoutComments}, inside a rule body.
 */
function selectorAt(offset: number): string {
  let depth = 0;
  let open = offset;
  for (; open >= 0; open--) {
    if (withoutComments[open] === '}') depth++;
    else if (withoutComments[open] === '{') {
      if (depth === 0) break;
      depth--;
    }
  }
  let start = open - 1;
  while (start >= 0 && !'{};'.includes(withoutComments[start])) start--;
  return withoutComments
    .slice(start + 1, open)
    .trim()
    .replace(/\s+/g, ' ');
}

/** The universal default's selector, and the Obsidian twin's. */
const UNIVERSAL = '*:where(:not(.copilot-view-content *):not(.milkdown *))';
const OBSIDIAN = '.copilot-view-content *:where(:not(.milkdown *))';

describe('the default border colour (index.css)', () => {
  it('declares a neutral border colour on every element', () => {
    // Tailwind's preflight resets elements to `border: 0 solid`, leaving
    // `border-color` at `currentColor`. Without this rule a bare `border`
    // class paints the text colour.
    expect(withoutComments).toContain(UNIVERSAL);
  });

  it(`keeps that rule inside @layer ${BORDER_LAYER}`, () => {
    const offset = withoutComments.indexOf(UNIVERSAL);
    expect(offset).toBeGreaterThan(-1);
    expect(enclosingAtRules(offset)).toContain(`@layer ${BORDER_LAYER}`);
  });

  it('layers the Obsidian twin too, and keeps it after the universal default', () => {
    // The Obsidian twin is the same kind of default — the neutral border,
    // sourced from the vault's theme instead of the app's. Unlayered it
    // outranked every utility inside the plugin's container for exactly the
    // reason the `*` rule did, so it moves with it (DOR-1024). It stays LATER
    // in the file so it wins the carve-out inside a shared layer.
    const universal = withoutComments.indexOf(UNIVERSAL);
    const obsidian = withoutComments.indexOf(OBSIDIAN);
    expect(obsidian).toBeGreaterThan(universal);
    expect(enclosingAtRules(obsidian)).toContain(`@layer ${BORDER_LAYER}`);
  });

  it('stands every border-colour default down inside the canvas editor', () => {
    // This layer sits ABOVE `blintz`, which inverts — for this one property —
    // the thing the `blintz` slot exists for. blintz declares a border colour
    // on five selectors and the three that matter are under the editor root
    // (`.milkdown-theme-nord blockquote`, `.milkdown-theme-nord.prose tr`);
    // without the exclusion the app's neutral line flattens all three.
    //
    // Asserted over every rule IN the layer rather than over the two selectors
    // this file happens to know about: each needs its own copy of the exclusion
    // (the Obsidian selector out-specifies the universal one, so an exclusion
    // written only on the latter would not reach the elements the former
    // matches), and a third default added later would need one too.
    const defaults = borderColorDeclarations()
      .filter((offset) => enclosingAtRules(offset).includes(`@layer ${BORDER_LAYER}`))
      .map(selectorAt);
    expect(defaults).toEqual([UNIVERSAL, OBSIDIAN]);
    for (const selector of defaults) {
      expect(selector).toContain(':not(.milkdown *)');
    }
  });

  it(`pins ${BORDER_LAYER} between blintz and utilities`, () => {
    // The rule being layered only helps if its layer is declared in the right
    // place — layer order is declaration order, not nesting.
    const order = /@layer\s+([^;]+);/.exec(withoutComments);
    expect(order).not.toBeNull();
    const names = order![1].split(',').map((name) => name.trim());
    expect(names.indexOf(BORDER_LAYER)).toBeGreaterThan(names.indexOf('blintz'));
    expect(names.indexOf(BORDER_LAYER)).toBeLessThan(names.indexOf('utilities'));
  });

  it('leaves no border-colour declaration unlayered', () => {
    // The general form of the bug, not just the two rules that had it: ANY
    // unlayered `border-color` in this file outranks every Tailwind utility, so
    // a new one would silently kill colour classes on whatever it matches.
    //
    // `@utility` and `@keyframes` are not exemptions granted on trust —
    // Tailwind compiles an `@utility` body into the `utilities` layer, and a
    // keyframe declaration is not part of the cascade at all.
    const layeredByConstruction = ['@layer', '@utility', '@keyframes'];
    const unlayered = borderColorDeclarations().filter(
      (offset) =>
        !enclosingAtRules(offset).some((prelude) =>
          layeredByConstruction.some((at) => prelude.startsWith(at))
        )
    );
    expect(unlayered.map(selectorAt)).toEqual([]);
  });
});
