// @vitest-environment node
// Reads the palette's own source off disk, so it needs real `file:` URLs —
// jsdom's `import.meta.url` is an http one and `fileURLToPath` refuses it.
/**
 * Scope is a chip, not a language (P3 AC-3, design-decisions §15).
 *
 * §15 chose the chip precisely so nobody has to learn `agent:foo before:bar` —
 * "the chip IS the syntax, and it's visible". The realistic regression is not
 * that somebody deletes the chip; it is that somebody adds a filter token
 * beside it because one query needed something the chip cannot say, and the
 * palette grows a half-language nobody documents.
 *
 * So this reads the feature's own source, the same way
 * `palette-ranks-names-not-content` does. A unit test can only assert about the corpus it was handed; this
 * asserts about every line that ships.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const FEATURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * The shapes a filter token would take if one arrived.
 *
 * Each matches a `<field>:` token being SPLIT OUT OF or MATCHED IN a string —
 * the parse, not the word. `scopeKey`'s own `agent:<path>` values are built by
 * `interactionKey` and never parsed back out of what a person typed, which is
 * why the patterns look for the parsing and not for the colon.
 */
const BANNED = [
  // A literal token being searched for in the query: `'before:'`, `"after:"`.
  /['"`](?:before|after|agent|room|session|is|in|from|type):['"`]/i,
  // A regex that pulls `<word>:<value>` pairs out of a string.
  /\\w\+\)?:\(/,
  /\[\^:\]\+:/,
  // The classic split-on-colon parse.
  /\.split\(\s*['"`]:['"`]\s*\)/,
];

/**
 * The same source with its comments taken out.
 *
 * The guard is about what the palette DOES, and the prose in these files names
 * the very tokens it is banning — this file's own reason for existing is a
 * sentence in `palette-scope.ts` reading "no `agent:`". Scanning comments would
 * make documenting the decision the thing that fails the check.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `.ts`/`.tsx` file the feature ships — tests excluded, they are not shipped. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the palette parses no query language', () => {
  const files = sourceFiles(FEATURE_DIR);

  it('reads a feature that actually has files in it', () => {
    // Without this, a broken path would make every claim below vacuously true.
    expect(files.length).toBeGreaterThan(15);
  });

  it('parses no filter token out of what a person typed', () => {
    const hits = files.flatMap((path) => {
      const source = code(readFileSync(path, 'utf8'));
      return BANNED.filter((pattern) => pattern.test(source)).map(
        (pattern) => `${path}: ${pattern}`
      );
    });
    expect(hits).toEqual([]);
  });

  it('would catch each of them if one arrived', () => {
    // The guard above passes trivially against a matcher that matches nothing.
    // This is the matcher being made to fire, once per pattern.
    const planted = [
      `if (term.startsWith('before:')) return filterByDate(term);`,
      String.raw`const TOKEN = /(\w+):(\S+)/g;`,
      String.raw`const PAIR = /[^:]+:(.*)/;`,
      `const [field, value] = term.split(':');`,
    ];
    expect(BANNED).toHaveLength(planted.length);
    for (const [index, pattern] of BANNED.entries()) {
      expect(pattern.test(planted[index] as string), String(pattern)).toBe(true);
    }
  });

  it('reads the whole search string as one term after a single prefix character', () => {
    // The only parse the palette does, pinned: one leading character, and
    // everything after it is what was typed. Nothing splits, nothing keys.
    const search = code(readFileSync(join(FEATURE_DIR, 'model', 'use-palette-search.ts'), 'utf8'));
    const parse = /export function parsePrefix[\s\S]*?\n}/.exec(search)?.[0] ?? '';
    expect(parse).not.toBe('');
    expect(parse).toContain('search.slice(1)');
    expect(parse).not.toMatch(/split|exec|match/);
  });
});
