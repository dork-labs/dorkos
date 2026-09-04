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
 * Bounded on both sides, so `transition-allowed` does not match. A backtick is
 * deliberately NOT a boundary: every mention in this codebase's prose is
 * written as markdown code — `` `transition-all` `` — and the several comments
 * explaining why not to use it must not read as uses of it.
 *
 * @param source - The file's text.
 */
function saysTransitionAll(source: string): boolean {
  return /(^|[\s'":[])transition-all($|[\s'"\]])/m.test(source);
}

/**
 * Every shipped `.ts`/`.tsx` file under `dir`, as `[path, text]`.
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
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
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
