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
 */
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '');
const REPO_ROOT = join(SCRIPTS_DIR, '..');

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
    const contents = readFileSync(file, 'utf8');
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
});
