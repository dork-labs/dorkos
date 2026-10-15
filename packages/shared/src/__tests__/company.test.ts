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

/**
 * Run `git grep` from the repo root; no match is an empty result, not an error.
 * The `-c` overrides keep a developer's git config (line numbers or columns
 * on by default, colour) from changing the `path:match` shape callers parse.
 */
function gitGrep(args: string[]): string[] {
  const config = [
    '-c',
    'grep.lineNumber=false',
    '-c',
    'grep.column=false',
    '-c',
    'color.grep=never',
  ];
  try {
    return execFileSync('git', [...config, 'grep', ...args], { cwd: ROOT, encoding: 'utf8' })
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
  'apps/site/src/app/(public)/cloud/terms/__tests__/page.test.tsx', // Pins the published legal page.
  'packages/connector-providers/LICENSE',
  'packages/doe/LICENSE', // Standalone license text cannot import the company module.
  'packages/shared/src/company.ts',
  'packages/ui/LICENSE',
];

/**
 * Files that use a person's own DorkOS address as an example; every other
 * address in source, docs and top-level documents must be one of
 * `company.emails`.
 */
const PERSONAL_EMAIL_EXAMPLES = [
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

/** Every code file under apps/ and packages/, the scope of the two source guards. */
const CODE_PATHS = ['ts', 'tsx', 'js', 'mjs', 'cjs'].flatMap((ext) => [
  `apps/**/*.${ext}`,
  `packages/**/*.${ext}`,
]);

/** A line whose code starts as a comment: it documents a value rather than holding one. */
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;

/**
 * Brand URLs, hosts and repository names that code builds from
 * `@dorkos/shared/links` (or `COMMUNITY_IMAGE_REPOSITORY`) instead of typing.
 * Each matches anywhere in a line, so a URL inside a longer string counts.
 */
const BRAND_LITERALS = [
  /https?:\/\/([a-z0-9-]+\.)*dorkos\.ai/,
  /github\.com\/dork-labs([^A-Za-z0-9_-]|$)/,
  /raw\.githubusercontent\.com\/dork-labs/,
  /api\.github\.com\/repos\/dork-labs/,
  /ghcr\.io\/dork-labs/,
  /['"`]dork-labs\/(dorkos|marketplace)\b/,
];

/**
 * Code files that may still type a brand URL, host or repository name, each
 * with the reason it cannot import the links module.
 */
const LITERAL_URL_ALLOWED: Record<string, string> = {
  'packages/shared/src/links.ts': 'the module itself',
  'packages/shared/src/community-release-manifest.ts':
    'the one definition of the Community image repository, which the CLI imports',
  'apps/client/eslint-rules/fsd.js':
    'an ESLint rule loaded as plain JS before any workspace package is built',
  'apps/community/acceptance/run.mjs':
    'a standalone acceptance script that runs without a workspace build',
  'apps/e2e/reporters/refresh-shard-timings.ts': '@dorkos/e2e does not depend on @dorkos/shared',
  'packages/cli/scripts/test-community-deploy-package.ts':
    'a test harness whose fake registry and attestation answers are sample data',
  'apps/server/src/services/mesh/refresh-untouched-templates.ts':
    'old template text that has to match what earlier versions wrote, byte for byte',
  'apps/community/src/browser/components/host/HostAdministration.tsx':
    'at the max-lines ratchet: the import line would grow a file that may only shrink',
  'apps/server/src/services/core/auth/cloud-link-client.ts':
    'at the max-lines ratchet: the import line would grow a file that may only shrink',
  'packages/cli/src/commands/community-deploy/community-dispatcher.ts':
    'at the max-lines ratchet: the import line would grow a file that may only shrink',
  'apps/client/src/dev/showcases/DataDisplayShowcases.tsx': 'Dev Playground sample data',
  'apps/client/src/dev/showcases/GenUiShowcases.tsx': 'Dev Playground sample data',
  'apps/client/src/dev/showcases/OnboardingFlowShowcases.tsx': 'Dev Playground sample data',
  'apps/client/src/dev/showcases/RoomDeliveryShowcases.tsx': 'Dev Playground sample data',
  'packages/test-utils/src/mock-factories.ts': 'test mock data',
};

/**
 * Code files that may type one of the company's email addresses instead of
 * importing it, each with the reason.
 */
const LITERAL_EMAIL_ALLOWED: Record<string, string> = {
  'packages/shared/src/company.ts': 'the module itself',
  'apps/e2e/capture/config.ts': '@dorkos/e2e does not depend on @dorkos/shared',
};

/** Code lines under apps/ and packages/ that mention `needle`, comments dropped, as `path:line:text`. */
function codeLinesMentioning(needle: string): Array<{ path: string; text: string }> {
  return gitGrep(['-n', '-I', '-E', needle, '--', ...CODE_PATHS, ...TEST_PATHS])
    .map((line) => /^([^:]+):\d+:(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, path, text]) => ({ path: path!, text: text! }))
    .filter(({ text }) => !COMMENT_LINE.test(text));
}

/** The npm packages this repo publishes, whose metadata must point at the repo. */
const PUBLISHED_PACKAGES = [
  'packages/cli',
  'packages/cloud-api',
  'packages/connector-providers',
  'packages/ui',
];

// Several checks scan the whole repository with git grep, which took over
// 5 seconds on a loaded merge-queue runner; the default timeout is too tight.
describe('company facts', { timeout: 30_000 }, () => {
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
      return !known.has(address!) && !PERSONAL_EMAIL_EXAMPLES.includes(path!);
    });
    expect(unknown).toEqual([]);
  });

  it('app and package code imports the email addresses instead of typing them', () => {
    const files = codeLinesMentioning('@dorkos\\.ai').map(({ path }) => path);
    expect([...new Set(files)].sort()).toEqual(Object.keys(LITERAL_EMAIL_ALLOWED).sort());
  });

  it('marketplace registry files name the marketplace owner address', () => {
    const registries = execFileSync(
      'git',
      ['ls-files', '--', ':(glob)**/.claude-plugin/marketplace.json'],
      { cwd: ROOT, encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean);
    expect(registries.length).toBeGreaterThan(0);
    for (const path of registries) {
      const registry = JSON.parse(read(path)) as { owner?: { email?: string } };
      if (registry.owner?.email?.endsWith('@dorkos.ai')) {
        expect(registry.owner.email, path).toBe(company.emails.marketplace);
      }
    }
  });

  it('app and package code builds brand URLs from the links module', () => {
    const files = codeLinesMentioning('dorkos\\.ai|dork-labs')
      .filter(({ text }) => BRAND_LITERALS.some((pattern) => pattern.test(text)))
      .map(({ path }) => path);
    expect([...new Set(files)].sort()).toEqual(Object.keys(LITERAL_URL_ALLOWED).sort());
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
