// @vitest-environment node
/**
 * Nothing in the client says `transition-all` (DOR-1764, finding 18.7).
 *
 * `transition-all` transitions every animatable property, layout ones
 * included, so a class swap nobody thought of as motion becomes motion. The
 * measured case: `Button`'s `h-11 md:h-9` meant dragging a window across 768px
 * animated the height of every button on screen. Naming the properties keeps
 * the answer to "what moves here?" readable in the class string itself.
 *
 * **A grep that finds nothing proves nothing.** Two positive controls run
 * before the sweep, so a typo'd pattern, a wrong root or a broken file walk
 * fails loudly instead of passing vacuously:
 *
 * - the **matcher** is run against a fixture that DOES say `transition-all`;
 * - the **walk** is asserted to find `transition-[` somewhere in the real
 *   tree, which is the shape this rule replaces it with.
 *
 * @module shared/ui/__tests__/no-transition-all
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

/**
 * `apps/client/src`, from this file.
 *
 * Resolved off `import.meta.url` under the `node` environment declared at the
 * top: jsdom hands out an `http:` one, which `fileURLToPath` refuses.
 */
const CLIENT_SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/** This guard's own path, which names the token in order to forbid it. */
const SELF = fileURLToPath(import.meta.url);

/**
 * The class appears as a whole Tailwind utility in a class string.
 *
 * Bounded on both sides, and a backtick counts as a boundary — a template
 * literal `className` is a shape this codebase uses (`TaskProgressHeader.tsx`),
 * and `` `transition-all duration-150` `` or `` cn(`p-2 transition-all`) `` are
 * real uses with the token first or last inside the backticks. That would also
 * catch this codebase's own prose, which quotes the token the same way —
 * `` `transition-all` `` — so the exact backtick-quoted mention is stripped
 * first: the several comments explaining why not to use it must not read as
 * uses of it.
 *
 * @param source - The file's text.
 */
function saysTransitionAll(source: string): boolean {
  const withoutProseMentions = source.replace(/`transition-all`/g, '');
  return /(^|[\s'":[`])transition-all($|[\s'"\]`])/m.test(withoutProseMentions);
}

/**
 * Every shipped `.ts`/`.tsx`/`.css` file under `dir`, as `[path, text]`.
 *
 * `.css` is in the walk because the rule this test enforces has a CSS-side
 * offender too — finding 18.7 named `index.css:549` as one, and a Tailwind
 * `@apply transition-all` is exactly as unaudited as the JSX form.
 *
 * Tests are skipped: the two that already pin this rule (`button.test.tsx`,
 * `TeamMemberCard.test.tsx`) assert `not.toContain('transition-all')`, which
 * quotes the token exactly the way a real class string would.
 *
 * @param dir - Directory to walk.
 */
function sourceFiles(dir: string): [string, string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(tsx?|css)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    if (full === SELF) continue;
    out.push([full, readFileSync(full, 'utf8')]);
  }
  return out;
}

describe('the matcher can fail', () => {
  it('finds the class in a fixture that carries it', () => {
    expect(saysTransitionAll('className="rounded transition-all duration-150"')).toBe(true);
    expect(saysTransitionAll("cn('p-2 transition-all')")).toBe(true);
  });

  it('does not fire on a longer utility that merely starts the same way', () => {
    expect(saysTransitionAll('className="transition-allowance"')).toBe(false);
  });

  it('does not fire on a comment explaining why not to use it', () => {
    expect(saysTransitionAll('// Named properties rather than `transition-all`.')).toBe(false);
  });

  it('finds the class at either edge of a template literal', () => {
    expect(saysTransitionAll('className={`transition-all duration-150`}')).toBe(true);
    expect(saysTransitionAll('cn(`p-2 transition-all`)')).toBe(true);
  });

  it('still ignores a backtick-quoted mention sitting beside real code', () => {
    expect(
      saysTransitionAll(
        '// twin of this hover). A `transition-all` here would put border width,\ntransition-[color]'
      )
    ).toBe(false);
  });
});

describe('no transition-all in the client', () => {
  const files = sourceFiles(CLIENT_SRC);

  it('walked a real tree', () => {
    // If this drops to zero the sweep below is vacuous, not clean.
    expect(files.filter(([, text]) => text.includes('transition-[')).length).toBeGreaterThan(10);
  });

  it('names its transitioned properties everywhere', () => {
    const offenders = files
      .filter(([, text]) => saysTransitionAll(text))
      .map(([path]) => relative(CLIENT_SRC, path));

    expect(offenders).toEqual([]);
  });
});
