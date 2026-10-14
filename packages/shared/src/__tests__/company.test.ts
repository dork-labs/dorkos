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
import { COPYRIGHT_NOTICE, company, formatCompanyAddress } from '../company.js';
import { links, repoUrl } from '../links.js';

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
  'packages/connector-providers/LICENSE',
  'packages/doe/LICENSE', // Standalone license text cannot import the company module.
  'packages/shared/src/company.ts',
  'packages/ui/LICENSE',
];

/**
 * Where a DorkOS email address may be typed outside the company module: a
 * person's own address used as an example, and fixtures that stand in for a
 * real registry. Every other address in source, docs and top-level documents
 * must be one of `company.emails`.
 */
const EMAIL_EXAMPLE_ALLOWED = [
  // Shows that an address does not open the @-mention picker.
  'apps/client/src/layers/features/mentions/model/use-mention-autocomplete.ts',
];

/** History and working notes, which keep the addresses they were written with. */
const HISTORY_PATHS = [
  ':!CHANGELOG.md',
  ':!changelog',
  ':!research',
  ':!plans',
  ':!specs',
  ':!decisions',
  ':!meta',
];

/** Test code and the client's sample data, which may use made-up addresses and URLs. */
const TEST_PATHS = [
  ':!**/__tests__/**',
  ':!**/*.test.*',
  ':!**/*.spec.*',
  ':!apps/client/src/dev/mock-samples/**',
];

/**
 * Source files that may still type a brand URL as a string: Dev Playground
 * showcases and test mocks, whose URLs are sample data rather than links a
 * person follows, and two files at the max-lines ratchet, where the import
 * line would grow a file that may only shrink (scripts/max-lines). Move
 * them to the links module when they are split.
 */
const LITERAL_URL_ALLOWED = [
  'apps/community/src/browser/components/host/HostAdministration.tsx',
  'apps/server/src/services/core/auth/cloud-link-client.ts',
  'apps/client/src/dev/showcases/DataDisplayShowcases.tsx',
  'apps/client/src/dev/showcases/GenUiShowcases.tsx',
  'apps/client/src/dev/showcases/OnboardingFlowShowcases.tsx',
  'apps/client/src/dev/showcases/RoomDeliveryShowcases.tsx',
  'packages/test-utils/src/mock-factories.ts',
];

/** The npm packages this repo publishes, whose metadata must point at the repo. */
const PUBLISHED_PACKAGES = [
  'packages/cli',
  'packages/cloud-api',
  'packages/connector-providers',
  'packages/ui',
];

describe('company facts', () => {
  it('carries exactly the published facts', () => {
    // A new field is a deliberate decision about what this public repo
    // publishes, so it has to be named here too.
    expect(Object.keys(company).sort()).toEqual(
      [
        'address',
        'emails',
        'entityType',
        'governingState',
        'jurisdiction',
        'legalName',
        'shortName',
      ].sort()
    );
  });

  it('publishes exactly the named email addresses, all on the company domain', () => {
    expect(company.emails).toEqual({
      contact: 'hey@dorkos.ai',
      support: 'support@dorkos.ai',
      security: 'security@dorkos.ai',
      marketplace: 'hello@dorkos.ai',
    });
  });

  it('formats the postal address on one line', () => {
    expect(formatCompanyAddress()).toBe('6028 Toscana Ave, Austin, TX 78724, United States');
    expect(formatCompanyAddress(company.address, { country: false })).toBe(
      '6028 Toscana Ave, Austin, TX 78724'
    );
  });

  it('the governing state is the one the company is formed in', () => {
    expect(company.jurisdiction.startsWith(company.governingState)).toBe(true);
  });

  it('the desktop build copyright and publisher match the module', () => {
    const yaml = read('apps/desktop/electron-builder.yml');
    expect(/^copyright:\s*(.+)$/m.exec(yaml)?.[1]?.trim()).toBe(COPYRIGHT_NOTICE);
    // electron-builder names the Windows publisher from package.json `author`.
    const pkg = JSON.parse(read('apps/desktop/package.json')) as { author?: unknown };
    expect(pkg.author).toBe(company.legalName);
  });

  it('SECURITY.md and the code of conduct send reports to the security address', () => {
    for (const path of ['SECURITY.md', 'CODE_OF_CONDUCT.md']) {
      const addresses = read(path).match(/[\w.+-]+@dorkos\.ai/g) ?? [];
      expect(addresses.length, path).toBeGreaterThan(0);
      expect(new Set(addresses), path).toEqual(new Set([company.emails.security]));
    }
  });

  it('every DorkOS email address in the repo is one the company module names', () => {
    const known = new Set<string>(Object.values(company.emails));
    const unknown = gitGrep([
      '-o',
      '-I',
      '-E',
      '[A-Za-z0-9._+-]+@dorkos\\.ai',
      '--',
      '.',
      ...HISTORY_PATHS,
      ...TEST_PATHS,
    ]).filter((line) => {
      const [path, address] = line.split(':');
      return !known.has(address!) && !EMAIL_EXAMPLE_ALLOWED.includes(path!);
    });
    expect(unknown).toEqual([]);
  });

  it('app and package source build brand URLs from the links module', () => {
    const hits = gitGrep([
      '-n',
      '-I',
      '-E',
      `['"\`]https://(www\\.)?(dorkos\\.ai|github\\.com/dork-labs/|npmjs\\.com/package/dorkos)`,
      '--',
      'apps/**/*.ts',
      'apps/**/*.tsx',
      'packages/**/*.ts',
      'packages/**/*.tsx',
      ':!packages/shared/src/links.ts',
      ...TEST_PATHS,
    ]);
    // A URL named in a comment documents the link; only code values count.
    const files = hits
      .filter((line) => !/^[^:]+:\d+:\s*(\/\/|\/?\*)/.test(line))
      .map((line) => line.split(':')[0]!);
    expect([...new Set(files)].sort()).toEqual([...LITERAL_URL_ALLOWED].sort());
  });

  it('published package metadata points at the repository', () => {
    for (const dir of PUBLISHED_PACKAGES) {
      const pkg = JSON.parse(read(`${dir}/package.json`)) as {
        repository?: { url?: string; directory?: string };
        homepage?: string;
        bugs?: string;
      };
      expect(pkg.repository?.url?.replace(/^git\+/, ''), dir).toBe(`${links.repo}.git`);
      expect(pkg.repository?.directory, dir).toBe(dir);
      if (pkg.homepage !== undefined) {
        expect(
          pkg.homepage === links.site || pkg.homepage.startsWith(`${links.repo}/`),
          `${dir} homepage ${pkg.homepage}`
        ).toBe(true);
      }
      if (pkg.bugs !== undefined) expect(pkg.bugs, dir).toBe(repoUrl('/issues'));
    }
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
