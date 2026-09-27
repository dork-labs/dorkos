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
 * DELIBERATELY NOT A PARSER. An earlier version of this file used the real
 * TypeScript scanner to strip comment trivia before matching — and that
 * still had its own sharp edges: `Array.from(source)` indexes by CODE POINT
 * while the scanner reports UTF-16 code-unit offsets, so an emoji or other
 * astral character before a comment could desync the two and blank the
 * wrong span; `scan()` never re-enters a template literal's `${...}` hole on
 * its own, so a template after another template could desync the token
 * stream; and a regex literal containing `\/\/` is legitimate source the
 * scanner has to get exactly right to avoid reading it as a comment. Zero of
 * those ever misfired here, but "zero misfires so far" is not the same
 * guarantee as "structurally cannot misfire" — so this test stops trying to
 * understand the language at all. Instead: a line counts as a comment ONLY
 * when the ENTIRE trimmed line is one — starts with `//`, `/*`, or `*` (the
 * three shapes DorkOS's own TSDoc/JSDoc comments take, opener, opener, and
 * continuation/closer). Anything else is scanned as ordinary text, including
 * a trailing comment on a code line — so naming a bad class ONLY in a
 * trailing comment can false-positive this guard. That is an accepted
 * trade: reword the comment, rather than trust a parser to get every string,
 * template, regex-literal and Unicode edge case right forever.
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

/**
 * True when a line is NOTHING but a comment — the only shape this guard
 * treats as unreadable (see the file header for why it stops there). A line
 * with real code and a trailing `//` or `/* ... *\/` still counts as code:
 * this only recognizes the opener/continuation/closer shapes DorkOS's own
 * TSDoc uses when they own the WHOLE line.
 */
function isCommentOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
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
 * Every match of `pattern` on a scannable (non-comment-only) line of `text`.
 * The one code path both {@link findUndefinedStatusClasses} and this file's
 * own regression tests run through, so a test proves what the real guard
 * does rather than a reimplementation of it.
 */
function scanLines(text: string, pattern: RegExp): Match[] {
  const matches: Match[] = [];
  text.split('\n').forEach((line, index) => {
    if (isCommentOnlyLine(line)) return;
    const found = line.match(pattern);
    if (!found) return;
    for (const className of found) matches.push({ line: index + 1, className });
  });
  return matches;
}

interface Finding extends Match {
  readonly file: string;
}

/** Bare status-shaped color classes (`text-warning`, `bg-danger/30`, …) a consumer's CSS never defines. */
function findUndefinedStatusClasses(consumer: Consumer): Finding[] {
  const defined = definedColorNames(consumer.cssFile);
  const undefinedNames = BARE_STATUS_NAMES.filter((name) => !defined.has(name));
  if (undefinedNames.length === 0) return [];

  const pattern = new RegExp(
    `\\b(?:${COLOR_PREFIXES.join('|')})-(?:${undefinedNames.join('|')})\\b`,
    'g'
  );

  const findings: Finding[] = [];
  for (const file of collectSourceFiles(join(REPO_ROOT, consumer.srcDir))) {
    const contents = readFileSync(file, 'utf8');
    for (const match of scanLines(contents, pattern)) {
      findings.push({ file: relative(REPO_ROOT, file), ...match });
    }
  }
  return findings;
}

describe('status-shaped Tailwind color classes', () => {
  for (const consumer of CONSUMERS) {
    it(`${consumer.name} never uses a bare status color name undefined in its CSS`, () => {
      expect(findUndefinedStatusClasses(consumer)).toEqual([]);
    }, 20_000);
  }

  it('does not flag a mention inside a whole-line comment, in any shape DorkOS TSDoc uses', () => {
    // Regression check for the false-positive this guard must not produce:
    // naming the bug's own class shape in prose must never be mistaken for
    // the class itself. Built from parts rather than written verbatim, so
    // this suite's own file doesn't hand the guard a literal match on itself.
    const bannedText = ['text', 'warning'].join('-');
    const pattern = new RegExp(`\\btext-warning\\b`);
    const source = [
      `/** This component used to render with ${bannedText}, which was a bug. */`,
      ` * ${bannedText} — a block-comment continuation line names it too.`,
      ` */`,
      `// ${bannedText} was undefined too — see DOR-2444.`,
      "const real = 'text-status-warning-fg';",
    ].join('\n');
    expect(scanLines(source, pattern)).toEqual([]);
  });

  it('still flags a real class after a `//` inside a URL (must-flag)', () => {
    // Regression for the false-negative a naive `//`-splits-a-line stripper
    // produces: it cannot tell a `//` that opens a line comment from one
    // inside `https://example.com`. This guard never tries to tell the
    // difference — the whole line isn't a comment, so it's scanned as-is.
    const cls = ['text', 'warning'].join('-');
    const pattern = new RegExp(`\\b${cls}\\b`);
    const source = `const url = 'https://example.com/page'; className='${cls}'`;
    expect(scanLines(source, pattern)).toEqual([{ line: 1, className: cls }]);
  });

  it('still flags real classes after a `/*`-shaped string, across several lines (must-flag)', () => {
    // Regression for the false-negative a naive `/\*...\*\//` stripper
    // produces: it cannot tell a `/*` that opens a block comment from one
    // inside `'rm build/*.js'`, and would swallow every line up to the next
    // literal `*/` anywhere later in the file (this is what made 54 real
    // lines of TouchChipStrip.test.tsx invisible to an earlier version of
    // this guard). None of these lines starts with a comment marker, so all
    // of them are scanned.
    const clsWarning = ['text', 'warning'].join('-');
    const clsDanger = ['bg', 'danger'].join('-');
    const pattern = new RegExp(`\\b(?:${clsWarning}|${clsDanger})\\b`);
    const lines = [
      "const cmd = 'rm build/*.js';",
      `className='${clsWarning}'`,
      "const other = 'src/**/*.ts';",
      `className='${clsDanger}'`,
      '/* a real, whole-line comment several lines below both fake openers */',
    ];
    const source = lines.join('\n');
    expect(scanLines(source, pattern)).toEqual([
      { line: 2, className: clsWarning },
      { line: 4, className: clsDanger },
    ]);
  });

  it('still flags a real class on a line that starts with an emoji (must-flag)', () => {
    // Regression for the UTF-16-vs-code-point indexing risk a character-level
    // stripper carries: an astral character (most emoji) is a surrogate PAIR
    // in UTF-16 but ONE entry in a code-point array like `Array.from`, so the
    // two can desync and blank the wrong span. This guard never indexes into
    // the string at all — `.trim().startsWith(...)` is Unicode-safe on its
    // own — so there is nothing to desync.
    const cls = ['text', 'warning'].join('-');
    const pattern = new RegExp(`\\b${cls}\\b`);
    const source = `✅ console.log('done'); className='${cls}'`;
    expect(scanLines(source, pattern)).toEqual([{ line: 1, className: cls }]);
  });

  it('still flags a real class after two template literals with `${}` interpolation (must-flag)', () => {
    // Regression for the token-stream desync risk a stateful scanner
    // carries: `scan()` does not automatically re-enter a template literal's
    // `${...}` hole, so a SECOND template later in the file could be read
    // from the wrong state. This guard tracks no state between lines, so a
    // template — or two in a row — cannot affect how any other line reads.
    const cls = ['bg', 'danger'].join('-');
    const pattern = new RegExp(`\\b${cls}\\b`);
    const source = [
      'const a = `Hello, ${name}!`;',
      'const b = `Another ${greeting} template`;',
      `className='${cls}'`,
    ].join('\n');
    expect(scanLines(source, pattern)).toEqual([{ line: 3, className: cls }]);
  });

  it('still flags a real class after a regex literal containing escaped slashes (must-flag)', () => {
    // Regression for the risk any comment-aware stripper carries: a regex
    // literal like `/^https?:\/\//` contains `\/\/`, which a stripper has to
    // recognize as part of the regex token, not a line comment. This guard
    // never looks for `//` mid-line at all, so the question doesn't arise.
    const cls = ['text', 'warning'].join('-');
    const pattern = new RegExp(`\\b${cls}\\b`);
    const source = `const re = /^https?:\\/\\//; className='${cls}'`;
    expect(scanLines(source, pattern)).toEqual([{ line: 1, className: cls }]);
  });
});
