/**
 * The company's name lives in one module, `packages/shared/src/company.ts`.
 *
 * Pages and app code import it. A few files cannot (LICENSE text, the desktop
 * app's electron-builder YAML and package.json), so they hold the literal
 * name, and this file keeps them agreeing with the module: change the entity
 * there and every literal copy turns this test red until it follows. It also
 * refuses a new hand-typed copy of the name, and the previous entity's name
 * coming back (DOR-2675).
 *
 * It lives in this package rather than under repo-root `scripts/` because the
 * merge queue runs every package's full suite, while the scripts job is scoped
 * to the paths that reach it, so a LICENSE or page edit would never run it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COPYRIGHT_NOTICE, company } from '../company.js';

/** Repo root, so the test does not depend on the directory vitest runs from. */
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** Read a tracked file by its repo-relative path. */
function read(path: string): string {
  return readFileSync(`${ROOT}/${path}`, 'utf8');
}

/** Run `git grep` from the repo root; no match is an empty result, not an error. */
function gitGrep(args: string[]): string[] {
  try {
    return execFileSync('git', ['grep', ...args], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** The first `Copyright (c) <year> <holder>` line's holder, or undefined. */
function copyrightHolder(text: string): string | undefined {
  return /^Copyright \(c\) \d{4}(?:-\d{4})? (.+)$/m.exec(text)?.[1]?.trim();
}

/** Every tracked license file in the repo (`LICENSE`, `LICENSE.md`, `LICENSE.txt`). */
function trackedLicenses(): string[] {
  return execFileSync('git', ['ls-files', '--', ':(glob)**/LICENSE', ':(glob)**/LICENSE.*'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

/**
 * License files whose copyright names a person rather than the company. They
 * are left as they are on purpose (a person's copyright is theirs to assign);
 * every other license file must name the company.
 */
const PERSONAL_COPYRIGHT = new Map([
  ['packages/cli/LICENSE', 'Dorian Collier'],
  ['packages/cloud-api/LICENSE', 'Dorian Collier'],
]);

/**
 * The only files under apps/ and packages/ allowed to type the legal name:
 * the module itself, files that cannot import it, and one test that pins the
 * rendered About panel against an independent literal.
 */
const LITERAL_NAME_ALLOWED = [
  'apps/community/LICENSE',
  'apps/desktop/electron-builder.yml',
  'apps/desktop/package.json',
  'apps/desktop/src/main/__tests__/about.test.ts',
  'packages/shared/src/company.ts',
  'packages/ui/LICENSE',
];

describe('company facts', () => {
  it('carries exactly the published facts, and no postal address', () => {
    // A new field is a deliberate decision about what this public repo
    // publishes, so it has to be named here too.
    expect(Object.keys(company).sort()).toEqual(
      ['contactEmail', 'entityType', 'jurisdiction', 'legalName', 'shortName'].sort()
    );
  });

  it('the desktop build copyright and publisher match the module', () => {
    const yaml = read('apps/desktop/electron-builder.yml');
    expect(/^copyright:\s*(.+)$/m.exec(yaml)?.[1]?.trim()).toBe(COPYRIGHT_NOTICE);
    // electron-builder names the Windows publisher from package.json `author`.
    const pkg = JSON.parse(read('apps/desktop/package.json')) as { author?: unknown };
    expect(pkg.author).toBe(company.legalName);
  });

  it('every license file names the company, except the listed personal ones', () => {
    const licenses = trackedLicenses();
    expect(licenses).toContain('LICENSE');
    for (const path of PERSONAL_COPYRIGHT.keys()) expect(licenses).toContain(path);

    const holders = Object.fromEntries(licenses.map((path) => [path, copyrightHolder(read(path))]));
    const expected = Object.fromEntries(
      licenses.map((path) => [path, PERSONAL_COPYRIGHT.get(path) ?? company.legalName])
    );
    expect(holders).toEqual(expected);
  });

  it('app and package source import the legal name instead of typing it', () => {
    const files = gitGrep(['-l', '-I', '-F', company.legalName, '--', 'apps', 'packages']);
    expect(files.sort()).toEqual([...LITERAL_NAME_ALLOWED].sort());
  });

  it('the previous entity is not named in source, docs or top-level documents', () => {
    // Built from parts so this file never matches its own search. The gap
    // allows any short run of non-letters (a non-breaking space is two bytes).
    const pattern = ['Blaze', '[^A-Za-z0-9]{0,4}', 'Ventures'].join('');
    const matches = gitGrep([
      '-n',
      '-I',
      '-i',
      '-E',
      pattern,
      '--',
      'apps',
      'packages',
      'docs',
      'blog',
      ':(glob)*.md',
      ':(glob)LICENSE*',
    ]);
    expect(matches).toEqual([]);
  });
});
