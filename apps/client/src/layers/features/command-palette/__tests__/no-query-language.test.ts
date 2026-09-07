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

import { codeOnly, lexWithoutComments } from '../../../../../../../scripts/lib/code-only.mjs';

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
 *
 * The repo's shared stripper does it, not the regex pair this used to be: the
 * `(^|[^:])` guard was there to stop a URL's `//` opening a fake line comment,
 * one of several ways a pair of regexes desynchronises (DOR-642). The shared
 * one lexes with TypeScript's own parser, so a `//` inside a string is never a
 * comment and no such guard is needed.
 *
 * `lexWithoutComments` and NOT `lex`: every banned shape above is a QUOTED
 * token (`'before:'`) or a regex literal, which the literal-blanking stripper
 * erases outright. The scan would then match nothing and report a clean pass
 * over a palette it had not read.
 *
 * @param source - A palette source file's text.
 * @param path - Its path, which decides how it is lexed.
 */
function code(source: string, path: string): { code: string; parseErrors: number } {
  return lexWithoutComments(source, path);
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

  const scanned = files.map((path) => ({ path, ...code(readFileSync(path, 'utf8'), path) }));

  it('reads a feature that actually has files in it', () => {
    // Without this, a broken path would make every claim below vacuously true.
    expect(files.length).toBeGreaterThan(15);
    // And every one of them was really read. A file the stripper cannot parse
    // has a comment map made of guesses, and it fails silently — no hit in it
    // looks exactly like no offence in it.
    expect(scanned.filter((f) => f.parseErrors > 0).map((f) => f.path)).toEqual([]);
  });

  it('parses no filter token out of what a person typed', () => {
    const hits = scanned.flatMap(({ path, code: source }) =>
      BANNED.filter((pattern) => pattern.test(source)).map((pattern) => `${path}: ${pattern}`)
    );
    expect(hits).toEqual([]);
  });

  it('would catch each of them if one arrived, through the real strip', () => {
    // The guard above passes trivially against a matcher that matches nothing.
    // This is the matcher being made to fire, once per pattern — and routed
    // through `code()`, not against the raw string, because the strip is half
    // the pipeline. Every shape below is a QUOTED token or a regex literal, so
    // the repo's other stripper (`codeOnly`, which blanks literals to answer
    // "is this a call?") erases all four: the sweep above would go empty and
    // report a clean palette it had never read. Both directions are asserted.
    const planted = [
      `if (term.startsWith('before:')) return filterByDate(term);`,
      String.raw`const TOKEN = /(\w+):(\S+)/g;`,
      String.raw`const PAIR = /[^:]+:(.*)/;`,
      `const [field, value] = term.split(':');`,
    ];
    expect(BANNED).toHaveLength(planted.length);
    for (const [index, pattern] of BANNED.entries()) {
      const source = planted[index] as string;
      expect(pattern.test(code(source, 'planted.ts').code), String(pattern)).toBe(true);
      expect(pattern.test(codeOnly(source, 'planted.ts')), `codeOnly hides ${pattern}`).toBe(false);
    }
  });

  it('reads the whole search string as one term after a single prefix character', () => {
    // The only parse the palette does, pinned: one leading character, and
    // everything after it is what was typed. Nothing splits, nothing keys.
    const searchFile = join(FEATURE_DIR, 'model', 'use-palette-search.ts');
    const { code: search } = code(readFileSync(searchFile, 'utf8'), searchFile);
    const parse = /export function parsePrefix[\s\S]*?\n}/.exec(search)?.[0] ?? '';
    expect(parse).not.toBe('');
    expect(parse).toContain('search.slice(1)');
    expect(parse).not.toMatch(/split|exec|match/);
  });
});
