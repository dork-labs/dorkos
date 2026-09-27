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
 * Comments are stripped before matching, using the real TypeScript scanner
 * rather than a `/\/\/.../` regex — a regex cannot tell a `//` that starts a
 * line comment from a `//` inside `https://example.com`, and cannot tell a
 * `/*` that starts a block comment from one inside a string like
 * `'rm build/*.js'` (which opens a fake block comment that swallows
 * everything up to the next real `*\/` anywhere later in the file). The
 * scanner tokenizes the real language, so a TSDoc block or `//` note is
 * allowed to name `text-warning` in prose, the way this file's own header
 * just did, without tripping the guard — and a URL or glob pattern in a
 * string never gets mistaken for a comment.
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
import ts from 'typescript';
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
 * Blank out `/* ... *\/` and `// ...` comment TRIVIA — as the real TypeScript
 * scanner sees them, not as a regex guesses them — leaving every newline and
 * the length of every other character in place, so a class name mentioned
 * only in prose cannot match and line numbers in a reported finding stay
 * accurate. A regex over the raw text cannot distinguish a `//` that starts a
 * line comment from one inside a URL, or a `/*` that starts a block comment
 * from one inside a string; the scanner tokenizes the language and only ever
 * reports real comment trivia, so string and template contents (a URL, a
 * glob pattern, a shell command) pass through untouched.
 */
function stripComments(source: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source);
  const chars = Array.from(source);
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      for (let i = start; i < end; i++) {
        if (chars[i] !== '\n') chars[i] = ' ';
      }
    }
    token = scanner.scan();
  }
  return chars.join('');
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

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly className: string;
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
    const contents = stripComments(readFileSync(file, 'utf8'));
    contents.split('\n').forEach((line, index) => {
      const matches = line.match(pattern);
      if (!matches) return;
      for (const className of matches) {
        findings.push({ file: relative(REPO_ROOT, file), line: index + 1, className });
      }
    });
  }
  return findings;
}

describe('status-shaped Tailwind color classes', () => {
  for (const consumer of CONSUMERS) {
    it(`${consumer.name} never uses a bare status color name undefined in its CSS`, () => {
      expect(findUndefinedStatusClasses(consumer)).toEqual([]);
    });
  }

  it('does not flag a mention inside a comment', () => {
    // Regression check for the false-positive this guard must not produce:
    // naming the bug's own class shape in prose must never be mistaken for
    // the class itself. Built from parts rather than written verbatim, so
    // this suite's own file doesn't hand the guard a literal match on itself.
    const bannedText = ['text', 'warning'].join('-');
    const bannedBg = ['bg', 'warning'].join('-');
    const source = [
      `/** This component used to render with ${bannedText}, which was a bug. */`,
      `// ${bannedBg} was undefined too — see DOR-2444.`,
      "const real = 'text-status-warning-fg';",
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).not.toContain(bannedText);
    expect(stripped).not.toContain(bannedBg);
    expect(stripped).toContain("'text-status-warning-fg'");
  });

  it('does not swallow a real class that follows a `//` inside a URL', () => {
    // Regression for the false-negative a `/\/\/.../` regex produces: it
    // cannot tell a `//` that opens a line comment from one inside
    // `https://example.com`, so it blanked the rest of the line — hiding any
    // real class that came after the URL on the same line. Built from parts
    // (see the comment-mention test above) so this suite's own file doesn't
    // hand the guard a literal match on itself.
    const cls = ['text', 'warning'].join('-');
    const source = `const url = 'https://example.com/page'; className='${cls}'`;
    const stripped = stripComments(source);
    expect(stripped).toContain("'https://example.com/page'");
    expect(stripped).toContain(cls);
  });

  it('does not swallow real classes that follow a `/*`-shaped string, even across lines', () => {
    // Regression for the false-negative a `/\*[\s\S]*?\*\//` regex produces:
    // it cannot tell a `/*` that opens a block comment from one inside
    // `'rm build/*.js'`, so it opened a FAKE block comment that swallowed
    // every line up to the next literal `*/` anywhere later in the file —
    // which hid every real class usage in between, not just one line's worth
    // (this is what made 54 real lines of TouchChipStrip.test.tsx invisible
    // to the old stripper).
    const clsWarning = ['text', 'warning'].join('-');
    const clsDanger = ['bg', 'danger'].join('-');
    const source = [
      "const cmd = 'rm build/*.js';",
      `className='${clsWarning}'`,
      "const other = 'src/**/*.ts';",
      `className='${clsDanger}'`,
      '/* a real comment several lines below both fake openers */',
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).toContain("'rm build/*.js'");
    expect(stripped).toContain(clsWarning);
    expect(stripped).toContain("'src/**/*.ts'");
    expect(stripped).toContain(clsDanger);
  });
});
