// @vitest-environment node
/**
 * Guard for DOR-2444: `text-warning` compiles to nothing, because no
 * `--color-warning` custom property exists in `apps/client/src/index.css` —
 * Tailwind silently drops an unrecognized utility class rather than erroring,
 * so a warning meant to stand out rendered in ordinary text color instead.
 * DorkOS status/severity colors always ride a `status-` prefixed token
 * (`text-status-warning-fg`, `bg-status-success`, …); a bare `text-warning`,
 * `bg-success`, `border-danger`, etc. is never a real one here.
 *
 * This test scans every `.ts`/`.tsx` file under a Tailwind consumer's source
 * tree for a color utility built from one of those bare status names, and
 * fails if that name is not actually defined as a `--color-<name>` custom
 * property in the CSS that feeds that consumer's Tailwind build. It checks
 * the CSS rather than hard-coding "these five are always undefined" so the
 * day a consumer legitimately defines `--color-success` (as `apps/site`
 * already does, in its own `globals.css`, which is why it is not one of the
 * consumers below), this test stops flagging it there without an edit.
 *
 * USES THE REPO'S SHARED LEXER, NOT A GUARD-SPECIFIC STRIPPER. Two earlier
 * versions of this file rolled their own — first a regex pair, then a
 * hand-written TypeScript-scanner pass, then a "whole line or nothing" rule —
 * and each had its own way of getting comments wrong (a `//` inside a URL, a
 * `/*` inside a string, UTF-16-vs-code-point drift, template-literal state).
 * `scripts/lib/code-only.mjs` exists precisely because this repo already paid
 * for those mistakes once (DOR-642, DOR-1714) and a `no guard strips comments
 * with regexes of its own` census (`scripts/__tests__/code-only.test.ts`)
 * fails on sight if one grows back. `lexWithoutComments` is its answer to
 * "does this file SAY this word?" — the question this guard asks, since the
 * subject lives in a `className` string, which the sibling `lex`/`codeOnly`
 * (built for "is this a call?") would blank away along with the comments.
 * Precedent for the exact pairing used here: `apps/client/src/layers/
 * features/command-palette/__tests__/no-query-language.test.ts`.
 *
 * Because it is the real lexer, a TRAILING comment on a code line is handled
 * correctly too, not just a whole-line one — `x; // text-warning is retired`
 * loses only the comment, keeping any real usage on the same line. There is
 * no accepted false-positive case left to document.
 *
 * `parseErrors` is asserted to be zero across every corpus this file scans:
 * a file the lexer cannot parse produces a comment map made of guesses, and
 * failure there is silent — no hit in it reads exactly like no offense in it.
 *
 * Lives beside `status-warning-contrast.test.ts` in `apps/client`, not under
 * `scripts/`: `scripts/__tests__/*` only runs from the scoped `harness` job
 * in `scripts-test.yml`, which a client-only PR never triggers and the merge
 * queue never runs — a guard that lives there never actually gates anything.
 * `apps/client`'s own `test` task runs on every PR and in the merge queue, so
 * this file scans `packages/ui/src` and `apps/design-system/src` by relative
 * path from here rather than living in either of them.
 */
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lexWithoutComments } from '../../../../scripts/lib/code-only.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Status/severity color names that must always ride a `status-` prefixed token. */
const BARE_STATUS_NAMES = ['warning', 'success', 'danger', 'error', 'info'] as const;

/** Tailwind utility prefixes a color name can follow (`text-warning`, `bg-warning/5`, …). */
const COLOR_PREFIXES = [
  'text',
  'bg',
  'border',
  'ring',
  'fill',
  'stroke',
  'outline',
  'decoration',
  'divide',
  'placeholder',
  'caret',
  'accent',
  'shadow',
  'from',
  'via',
  'to',
] as const;

/** A Tailwind consumer: its source tree, and the CSS whose `--color-*` custom properties define its palette. */
interface Consumer {
  readonly name: string;
  readonly srcDir: string;
  readonly cssFile: string;
}

const CONSUMERS: readonly Consumer[] = [
  { name: 'apps/client', srcDir: 'apps/client/src', cssFile: 'apps/client/src/index.css' },
  { name: 'packages/ui', srcDir: 'packages/ui/src', cssFile: 'packages/ui/tailwind.css' },
  // apps/design-system has no CSS of its own beyond `@import '@dork-labs/ui/tailwind.css'`.
  {
    name: 'apps/design-system',
    srcDir: 'apps/design-system/src',
    cssFile: 'packages/ui/tailwind.css',
  },
];

/** Every `--color-<name>` custom property a CSS file defines, by its bare name. */
function definedColorNames(cssPath: string): Set<string> {
  const css = readFileSync(join(REPO_ROOT, cssPath), 'utf8');
  const names = new Set<string>();
  for (const match of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return names;
}

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(current: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(dir);
  return files;
}

interface Match {
  readonly line: number;
  readonly className: string;
}

/**
 * Every match of `pattern` in `text`, after `text`'s comments are blanked by
 * the shared lexer (`fileName`'s extension decides `.ts` vs `.tsx` lexing).
 * The one code path both {@link findUndefinedStatusClasses} and this file's
 * own regression tests run through, so a test proves what the real guard
 * does rather than a reimplementation of it.
 */
function scanLines(
  text: string,
  pattern: RegExp,
  fileName: string
): { matches: Match[]; parseErrors: number } {
  const { code, parseErrors } = lexWithoutComments(text, fileName);
  const matches: Match[] = [];
  code.split('\n').forEach((line, index) => {
    const found = line.match(pattern);
    if (!found) return;
    for (const className of found) matches.push({ line: index + 1, className });
  });
  return { matches, parseErrors };
}

interface Finding extends Match {
  readonly file: string;
}

/**
 * Bare status-shaped color classes (`text-warning`, `bg-danger/30`, …) a
 * consumer's CSS never defines, plus every file in its source tree the
 * shared lexer could not parse (which must be empty for the findings to mean
 * anything — see the file header).
 */
function findUndefinedStatusClasses(consumer: Consumer): {
  findings: Finding[];
  parseErrorFiles: string[];
} {
  const defined = definedColorNames(consumer.cssFile);
  const undefinedNames = BARE_STATUS_NAMES.filter((name) => !defined.has(name));
  if (undefinedNames.length === 0) return { findings: [], parseErrorFiles: [] };

  const pattern = new RegExp(
    `\\b(?:${COLOR_PREFIXES.join('|')})-(?:${undefinedNames.join('|')})\\b`,
    'g'
  );

  const findings: Finding[] = [];
  const parseErrorFiles: string[] = [];
  for (const file of collectSourceFiles(join(REPO_ROOT, consumer.srcDir))) {
    const relPath = relative(REPO_ROOT, file);
    const contents = readFileSync(file, 'utf8');
    const { matches, parseErrors } = scanLines(contents, pattern, file);
    if (parseErrors > 0) parseErrorFiles.push(relPath);
    for (const match of matches) findings.push({ file: relPath, ...match });
  }
  return { findings, parseErrorFiles };
}

describe('status-shaped Tailwind color classes', () => {
  for (const consumer of CONSUMERS) {
    // Scanned once per consumer, shared by both `it`s below — matching
    // `no-query-language.test.ts`'s shape, and avoiding walking a 3,600+ file
    // tree twice for two assertions about the one pass over it.
    const { findings, parseErrorFiles } = findUndefinedStatusClasses(consumer);

    it(`${consumer.name}: the lexer parsed every file (an unparseable one can't pass silently)`, () => {
      expect(parseErrorFiles).toEqual([]);
    }, 20_000);

    it(`${consumer.name} never uses a bare status color name undefined in its CSS`, () => {
      expect(findings).toEqual([]);
    }, 20_000);
  }

  it('does not flag a mention inside any comment shape — block, line, or trailing', () => {
    // Regression check for the false-positive this guard must not produce:
    // naming the bug's own class shape in prose must never be mistaken for
    // the class itself, in any of the shapes a comment can take. Built from
    // parts rather than written verbatim, so this suite's own file doesn't
    // hand the guard a literal match on itself.
    const bannedText = ['text', 'warning'].join('-');
    const pattern = new RegExp(`\\b${bannedText}\\b`);
    const source = [
      '/**',
      ` * This component used to render with ${bannedText}, which was a bug.`,
      ' */',
      `// ${bannedText} was undefined too — see DOR-2444.`,
      `const real = 'text-status-warning-fg'; // ${bannedText} is retired`,
      `const other = 1; /* ${bannedText} lives only in this trailing block */`,
    ].join('\n');
    const { matches, parseErrors } = scanLines(source, pattern, 'snippet.ts');
    expect(parseErrors).toBe(0);
    expect(matches).toEqual([]);
  });

  it('still flags a real class after a `//` inside a URL (must-flag)', () => {
    // A naive line-based stripper cannot tell a `//` that opens a line
    // comment from one inside `https://example.com`. The real lexer knows a
    // string literal when it sees one, so the URL and the real class after
    // it both survive.
    const cls = ['text', 'warning'].join('-');
    const pattern = new RegExp(`\\b${cls}\\b`);
    const source = `const url = 'https://example.com/page'; className='${cls}'`;
    const { matches, parseErrors } = scanLines(source, pattern, 'snippet.ts');
    expect(parseErrors).toBe(0);
    expect(matches).toEqual([{ line: 1, className: cls }]);
  });

  it('still flags real classes after a `/*`-shaped string, across several lines (must-flag)', () => {
    // A naive stripper cannot tell a `/*` that opens a block comment from one
    // inside `'rm build/*.js'`, and would swallow every line up to the next
    // literal `*/` anywhere later in the file (this is what made 54 real
    // lines of TouchChipStrip.test.tsx invisible to an earlier version of
    // this guard). The real lexer knows these are string contents, so
    // everything survives except the genuine comment on the last line.
    const clsWarning = ['text', 'warning'].join('-');
    const clsDanger = ['bg', 'danger'].join('-');
    const pattern = new RegExp(`\\b(?:${clsWarning}|${clsDanger})\\b`);
    const source = [
      "const cmd = 'rm build/*.js';",
      `className='${clsWarning}'`,
      "const other = 'src/**/*.ts';",
      `className='${clsDanger}'`,
      '/* a real comment several lines below both fake openers */',
    ].join('\n');
    const { matches, parseErrors } = scanLines(source, pattern, 'snippet.ts');
    expect(parseErrors).toBe(0);
    expect(matches).toEqual([
      { line: 2, className: clsWarning },
      { line: 4, className: clsDanger },
    ]);
  });

  it('still flags a real class on the line after an emoji-bearing comment (must-flag)', () => {
    // An astral character (most emoji) is a surrogate PAIR in UTF-16 but ONE
    // entry in a code-point array — a stripper that indexes with
    // `Array.from`/`[...text]` can desync from positions TypeScript reports
    // in UTF-16 code units, sliding a blanked span onto the code after an
    // emoji. `code-only.mjs` avoids this by construction (`text.split('')`,
    // never a code-point array); this proves the comment right after the
    // emoji is still blanked correctly and the real class on the next line
    // lands at the right line number.
    const cls = ['text', 'warning'].join('-');
    const pattern = new RegExp(`\\b${cls}\\b`);
    const source = [
      `console.log('✅ done'); // ${cls} named only in a trailing comment after an emoji`,
      `className='${cls}'`,
    ].join('\n');
    const { matches, parseErrors } = scanLines(source, pattern, 'snippet.ts');
    expect(parseErrors).toBe(0);
    expect(matches).toEqual([{ line: 2, className: cls }]);
  });

  it('still flags a real class after two template literals with `${}` interpolation (must-flag)', () => {
    // A hand-rolled scanner that tracks its own state can fail to re-enter a
    // template literal's `${...}` hole between two templates in a row,
    // desyncing everything read afterward. The real lexer has no such state
    // to lose, so a second template — or any number of them — cannot affect
    // how a later line reads.
    const cls = ['bg', 'danger'].join('-');
    const pattern = new RegExp(`\\b${cls}\\b`);
    const source = [
      'const a = `Hello, ${name}!`;',
      'const b = `Another ${greeting} template`;',
      `className='${cls}'`,
    ].join('\n');
    const { matches, parseErrors } = scanLines(source, pattern, 'snippet.ts');
    expect(parseErrors).toBe(0);
    expect(matches).toEqual([{ line: 3, className: cls }]);
  });

  it('still flags a real class after a regex literal containing escaped slashes (must-flag)', () => {
    // A regex literal like `/^https?:\/\//` contains `\/\/`, which any
    // comment-aware stripper has to recognize as part of the regex token, not
    // a line comment. The real lexer decides `/` vs regex-vs-division from
    // the actual grammar, so the literal and the real class after it survive.
    const cls = ['text', 'warning'].join('-');
    const pattern = new RegExp(`\\b${cls}\\b`);
    const source = `const re = /^https?:\\/\\//; className='${cls}'`;
    const { matches, parseErrors } = scanLines(source, pattern, 'snippet.ts');
    expect(parseErrors).toBe(0);
    expect(matches).toEqual([{ line: 1, className: cls }]);
  });
});
