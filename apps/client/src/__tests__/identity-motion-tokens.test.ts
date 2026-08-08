/**
 * The stylesheet half of the identity interaction grammar.
 *
 * Every hover, press and focus the grammar prescribes is a CSS transition whose
 * duration and curve come from a token in `index.css`. Two things therefore
 * have to be true of that file, and nothing in a component test can see either:
 *
 * 1. **The tokens exist.** A component asking for `duration-(--identity-answer)`
 *    against a missing property gets `transition-duration: ` — an invalid
 *    declaration the browser drops, so the state snaps rather than moves, and
 *    every class assertion elsewhere still passes.
 * 2. **The global reduced-motion reset still collapses transitions.** It is the
 *    ONLY thing making the whole grammar reduced-motion-correct. No
 *    prescription carries a `motion-reduce:` variant, deliberately, because
 *    every one of them is a static end state that reads on its own — a ring is
 *    present, a border is coloured, a card is lifted. Remove the reset and all
 *    of them silently start moving for a reader who asked them not to.
 *
 * Read off the source, like `animation-utilities.test.ts` beside it: jsdom
 * resolves no custom property from a stylesheet it never loaded, and a token
 * that exists only in a fixture is a token that does not exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8'
);

describe('identity motion tokens (index.css)', () => {
  it.each([
    ['--identity-press', '80ms'],
    ['--identity-answer', '120ms'],
    ['--identity-settle', '200ms'],
    ['--identity-ease-out', 'cubic-bezier(0, 0, 0.2, 1)'],
    ['--identity-ease-standard', 'cubic-bezier(0.4, 0, 0.2, 1)'],
    ['--identity-border-mix', '35%'],
    ['--identity-ring-mix', '60%'],
  ])('declares %s as %s', (token, value) => {
    expect(indexCss).toContain(`${token}: ${value};`);
  });

  it('names three speeds and two curves, and nothing more', () => {
    // A fourth speed is a fourth opinion about how fast this cockpit answers.
    // If one is genuinely needed it belongs in the design spec first —
    // `plans/identity-micro-interactions/design-spec.md` §2.2.
    const declared = new Set(indexCss.match(/--identity-[\w-]+(?=:)/g) ?? []);

    expect(declared).toEqual(
      new Set([
        '--identity-press',
        '--identity-answer',
        '--identity-settle',
        '--identity-ease-out',
        '--identity-ease-standard',
        '--identity-border-mix',
        '--identity-ring-mix',
      ])
    );
  });
});

describe('the global reduced-motion reset (index.css)', () => {
  it('still collapses every transition and animation duration', () => {
    const reset = indexCss.slice(indexCss.lastIndexOf('@media (prefers-reduced-motion: reduce)'));

    expect(reset).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/);
    expect(reset).toContain('transition-duration: 0.01ms !important;');
    expect(reset).toContain('animation-duration: 0.01ms !important;');
  });
});
