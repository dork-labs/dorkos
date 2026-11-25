/**
 * The daily release commit, planned over the fixture release point
 * (DOR-5123, design §3). Each case copies `fixtures/repo/` to a temp
 * directory, changes what it needs, and plans; nothing here runs git or
 * reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkReleaseCherryPicks } from '../../../packages/cli/scripts/release-branch/rules.ts';
import { BREAKING_CALLOUT, sectionBody } from '../changelog.ts';
import { ReleaseCommitError } from '../errors.ts';
import { MIGRATIONS_FILE } from '../migration-table.ts';
import { planJson, selfCheck, type PlannedChange, type ReleasePlan } from '../plan.ts';
import { fixtureRepo, FIXTURE_DATE, FIXTURE_MIGRATIONS, type FixtureRepo } from './fixture-repo.ts';

let repo: FixtureRepo;
beforeEach(() => {
  repo = fixtureRepo();
});
afterEach(() => repo.cleanup());

const ADDED =
  '---\ncovers:\n  - "feat(todos): to-dos for everyone"\n---\n\n### Added\n\n- Add to-dos.\n';
const REMOVED = '### Removed\n\n- Remove the old export button.\n';

function change(plan: ReleasePlan, path: string): PlannedChange {
  const found = plan.changes.find((entry) => entry.path === path);
  if (!found) throw new Error(`no planned change for ${path}`);
  return found;
}

function after(plan: ReleasePlan, path: string): string {
  return change(plan, path).after ?? '';
}

describe('the version bump', () => {
  it('is a patch when no fragment adds, removes or breaks anything', () => {
    const plan = repo.plan();
    expect(plan.version).toBe('0.20.1');
    expect(plan.decision).toMatchObject({ bump: 'patch', breaking: false });
    expect(after(plan, 'VERSION')).toBe('0.20.1');
  });

  it('is a minor when a fragment adds something', () => {
    repo.write('changelog/unreleased/261102-000000-todos.md', ADDED);
    const plan = repo.plan();
    expect(plan.version).toBe('0.21.0');
    expect(plan.decision).toMatchObject({ bump: 'minor', breaking: false });
    expect(plan.decision.reason).toContain('261102-000000-todos.md');
    expect(plan.section.body[0]).not.toBe(BREAKING_CALLOUT);
  });

  it('is a flagged minor, called out at the top, when a fragment removes something', () => {
    repo.write('changelog/unreleased/261102-000000-export.md', REMOVED);
    const plan = repo.plan();
    expect(plan.version).toBe('0.21.0');
    expect(plan.decision).toMatchObject({ bump: 'minor', breaking: true });
    expect(plan.section.body[0]).toBe(BREAKING_CALLOUT);
    expect(after(plan, 'CHANGELOG.md')).toContain(
      `## [0.21.0] - ${FIXTURE_DATE}\n\n${BREAKING_CALLOUT}\n`
    );
  });

  it('flags a breaking bullet or a `!` commit claim as breaking too', () => {
    repo.write(
      'changelog/unreleased/261102-000000-api.md',
      '---\ncovers:\n  - "fix(api)!: rename the field"\n---\n\n### Changed\n\n- Rename a field.\n'
    );
    expect(repo.plan().decision.breaking).toBe(true);
    repo.write(
      'changelog/unreleased/261102-000000-api.md',
      '### Changed\n\n- **Breaking:** the export now needs a sign-in.\n'
    );
    expect(repo.plan().decision.breaking).toBe(true);
    repo.write(
      'changelog/unreleased/261102-000000-api.md',
      '### Changed\n\n- The API is BREAKING for old clients.\n'
    );
    expect(repo.plan().decision.breaking).toBe(true);
  });

  it('does not read BREAKING inside code or a longer word as breaking', () => {
    const file = 'changelog/unreleased/261102-000000-api.md';
    for (const text of [
      '### Changed\n\n- Mark the change `BREAKING` in the commit footer.\n',
      '### Changed\n\n- The update is NON-BREAKING for every client.\n',
      '### Changed\n\n- Write the footer like this:\n\n  ```text\n  BREAKING CHANGE: x\n  ```\n',
    ]) {
      repo.write(file, text);
      expect(repo.plan().decision, text).toMatchObject({ breaking: false, bump: 'patch' });
    }
  });

  it('takes --version when it moves forward', () => {
    expect(repo.plan({ version: '0.25.0' })).toMatchObject({
      version: '0.25.0',
      decision: { bump: 'override' },
    });
  });

  it('refuses a --version that is not greater than --previous', () => {
    expect(() => repo.plan({ version: '0.19.9' })).toThrow(/not greater than the last release/);
    expect(() => repo.plan({ version: '0.20.0' })).toThrow(ReleaseCommitError);
  });

  it('refuses a breaking change after 1.0, which needs a person', () => {
    repo.write('changelog/unreleased/261102-000000-export.md', REMOVED);
    for (const file of ['VERSION', 'docs/api/openapi.json', 'package.json'])
      repo.write(file, repo.read(file).replaceAll('0.20.0', '1.0.0'));
    expect(() => repo.plan({ previous: '1.0.0' })).toThrow(/needs a person/);
  });
});

describe('a rollback (design §6)', () => {
  // The fixture stands in for P_prev: the commit the release before the bad
  // one was cut at, so its fragments are that release's.
  it('ships as the next patch after the bad version, whatever the fragments call for', () => {
    repo.write('changelog/unreleased/261102-000000-todos.md', ADDED);
    const plan = repo.plan({ rollback: '0.22.0' });
    expect(plan.version).toBe('0.22.1');
    expect(plan.rollbackOf).toBe('0.22.0');
    expect(plan.decision).toMatchObject({ bump: 'override', version: '0.22.1' });
    expect(plan.decision.reason).toContain('rolls back 0.22.0');
    expect(after(plan, 'VERSION')).toBe('0.22.1');
  });

  it("opens the section with the rollback line, then the release's own notes byte for byte", () => {
    const plain = repo.plan({ version: '0.22.1' });
    const plan = repo.plan({ rollback: '0.22.0' });
    expect(plan.section.body).toEqual(['Rolled back 0.22.0.', '', ...plain.section.body]);
    expect(sectionBody(after(plan, 'CHANGELOG.md'), '0.22.1')).toEqual(plan.section.body);
    expect(plan.notes.startsWith('Rolled back 0.22.0.\n\n')).toBe(true);
    expect(plan.prBody).toContain('**Rollback of v0.22.0.**');
    expect(JSON.parse(planJson(plan))).toMatchObject({ version: '0.22.1', rollbackOf: '0.22.0' });
    expect(JSON.parse(planJson(plain))).toMatchObject({ rollbackOf: null });
  });

  it('passes release-branch-contents like any release commit', () => {
    expect(selfCheck(repo.plan({ rollback: '0.22.0' }))).toEqual([]);
  });

  it('refuses --version alongside it, and a bad version that is not after the release point', () => {
    expect(() => repo.plan({ rollback: '0.22.0', version: '0.22.1' })).toThrow(/drop --version/);
    expect(() => repo.plan({ rollback: '0.20.0' })).toThrow(/not newer than/);
    expect(() => repo.plan({ rollback: 'latest' })).toThrow(/--rollback must be a plain X.Y.Z/);
  });
});

describe('the config migration floor', () => {
  const withKey = (key: string, table = FIXTURE_MIGRATIONS) =>
    repo.write(MIGRATIONS_FILE, table.replace('} as const;', `  '${key}': later,\n} as const;`));

  it('leaves the bump alone when every key has run, the leading 1.0.0 sentinel included', () => {
    const plan = repo.plan();
    expect(plan.decision).toMatchObject({ version: '0.20.1', bump: 'patch' });
    expect(plan.decision.migrationKey).toBeUndefined();
    expect(plan.prBody).not.toContain('Config migrations');
  });

  it('raises a patch to the newest key and says why in the plan and the PR body', () => {
    withKey('0.21.0');
    const plan = repo.plan();
    expect(plan.decision).toMatchObject({
      version: '0.21.0',
      bump: 'minor',
      migrationKey: '0.21.0',
      raisedFrom: '0.20.1',
    });
    expect(plan.decision.reason).toContain("config migration key '0.21.0'");
    expect(after(plan, 'VERSION')).toBe('0.21.0');
    expect(JSON.parse(planJson(plan))).toMatchObject({
      migrationKey: '0.21.0',
      raisedFrom: '0.20.1',
    });
    expect(plan.prBody).toContain('raised from 0.20.1 to reach the key `0.21.0`');
  });

  it('keeps a bump that already reaches the key, and names the key', () => {
    withKey('0.20.1');
    const plan = repo.plan();
    expect(plan.decision).toMatchObject({ version: '0.20.1', migrationKey: '0.20.1' });
    expect(plan.decision.raisedFrom).toBeUndefined();
    expect(plan.prBody).toContain('the newest key, `0.20.1`, runs in this release');
  });

  it('refuses a key that is neither the next patch nor the next minor, the sentinel moved included', () => {
    for (const key of ['0.22.0', '0.20.2', '0.21.1']) {
      withKey(key);
      expect(() => repo.plan(), key).toThrow(`'${key}', which is neither the next patch`);
    }
    withKey('1.0.0', FIXTURE_MIGRATIONS.replace("'1.0.0'", "'0.18.0'"));
    expect(() => repo.plan()).toThrow(/'1.0.0', which is neither/);
  });

  it('lets --version name any version at or above the newest key, and refuses one below it', () => {
    withKey('0.21.0');
    expect(() => repo.plan({ version: '0.20.5' })).toThrow(/below the newest config migration key/);
    expect(repo.plan({ version: '0.21.0' }).version).toBe('0.21.0');
    withKey('0.23.0');
    expect(repo.plan({ version: '0.23.0' }).decision).toMatchObject({ migrationKey: '0.23.0' });
  });

  it('refuses a table it cannot read rather than planning past it', () => {
    repo.write(MIGRATIONS_FILE, 'export const OTHER = {};\n');
    expect(() => repo.plan()).toThrow(/cannot tell which migrations it must reach/);
    repo.remove(MIGRATIONS_FILE);
    expect(() => repo.plan()).toThrow(/has no file apps\/server/);
  });
});

describe('refusals before anything is planned', () => {
  it('refuses a release point with no fragments', () => {
    for (const name of ['000000-keep-settings', '000100-room-rules', '000200-upgrade-note'])
      repo.remove(`changelog/unreleased/261101-${name}.md`);
    expect(() => repo.plan()).toThrow(/Nothing to release/);
  });

  it('refuses when VERSION is not the previous release', () => {
    repo.write('VERSION', '0.19.1');
    expect(() => repo.plan()).toThrow(/VERSION at the release point is "0.19.1"/);
  });

  it('refuses a package.json that is not at the previous release', () => {
    repo.write(
      'apps/desktop/package.json',
      repo.read('apps/desktop/package.json').replace('0.20.0', '0.19.0')
    );
    expect(() => repo.plan()).toThrow(/apps\/desktop\/package.json has version "0.19.0"/);
  });

  it('refuses a seeded fragment, an unknown heading and text outside a heading', () => {
    const file = 'changelog/unreleased/261102-000000-x.md';
    repo.write(file, '<!-- dorkos-changelog:seeded -->\n### Fixed\n\n- x\n');
    expect(() => repo.plan()).toThrow(/hook-seeded/);
    repo.write(file, '### Improved\n\n- x\n');
    expect(() => repo.plan()).toThrow(/### Improved/);
    repo.write(file, 'Stray words.\n\n### Fixed\n\n- x\n');
    expect(() => repo.plan()).toThrow(/before its first ### heading/);
  });

  it('refuses an HTML comment, which the docs page would show as text', () => {
    repo.write(
      'changelog/unreleased/261102-000000-x.md',
      '### Fixed\n\n<!-- a note to the reviewer -->\n- x\n'
    );
    expect(() => repo.plan()).toThrow(/has an HTML comment \(<!--\)/);
  });

  it('refuses a date that is not a real YYYY-MM-DD', () => {
    expect(() => repo.plan({ date: '2026-02-30' })).toThrow(/--date/);
    expect(() => repo.plan({ date: '24/11/2026' })).toThrow(/--date/);
  });

  it('refuses a stray file in changelog/unreleased', () => {
    repo.write('changelog/unreleased/notes.txt', 'x');
    expect(() => repo.plan()).toThrow(/is not a fragment/);
  });
});

describe('the version files', () => {
  it('changes only the top-level version of each package.json', () => {
    const plan = repo.plan();
    const cli = change(plan, 'packages/cli/package.json');
    expect(cli.after).toBe(cli.before?.replace('"version": "0.20.0"', '"version": "0.20.1"'));
    expect(JSON.parse(cli.after ?? '').pkg.version).toBe('0.20.0');
  });

  it("changes only the API document's info.version, byte for byte", () => {
    const api = change(repo.plan(), 'docs/api/openapi.json');
    expect(api.after).toBe(api.before?.replace('"version": "0.20.0"', '"version": "0.20.1"'));
    expect(JSON.parse(api.after ?? '').components.schemas.Health.example.version).toBe('0.20.0');
  });
});

describe('the changelog', () => {
  it('compiles every fragment under one heading per category, in order, below [Unreleased]', () => {
    const text = after(repo.plan(), 'CHANGELOG.md');
    const top = text.indexOf('## [0.20.1]');
    expect(top).toBeGreaterThan(text.indexOf('## [Unreleased]'));
    expect(top).toBeLessThan(text.indexOf('## [0.20.0]'));
    const body = sectionBody(text, '0.20.1');
    expect(body.filter((line) => line.startsWith('### '))).toEqual([
      '### Note for people upgrading',
      '### Changed',
      '### Fixed',
    ]);
    const fixed = body.slice(body.indexOf('### Fixed') + 2);
    expect(fixed).toEqual([
      '- Keep your chosen model when you send the first message in a new chat (DOR-1).',
      '- The rules page names its file again (DOR-2).',
    ]);
  });

  it('never compiles covers: frontmatter', () => {
    const plan = repo.plan();
    for (const path of ['CHANGELOG.md', 'docs/changelog.mdx']) {
      const text = after(plan, path);
      expect(text).not.toContain('covers:');
      expect(text).not.toContain('fix(rooms): room rules say who to ask');
    }
    expect(plan.notes).not.toContain('covers:');
  });

  it('puts a bare @handle in backticks and leaves emails, scopes and code alone', () => {
    const line = sectionBody(after(repo.plan(), 'CHANGELOG.md'), '0.20.1').find((entry) =>
      entry.startsWith('- Ask ')
    );
    expect(line).toBe(
      "- Ask `@fixture-person-zz9` before you change a room's rules, or write to me@example.com. Install `@fixture/pkg` or @dork-labs/cloud-api; `@inline-code` stays as it is."
    );
  });

  it('points [Unreleased] at the new tag and adds its compare link', () => {
    const text = after(repo.plan(), 'CHANGELOG.md');
    expect(text).toContain(
      '[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.20.1...HEAD\n[0.20.1]: https://github.com/dork-labs/dorkos/compare/v0.20.0...v0.20.1\n'
    );
  });

  it('deletes every compiled fragment and keeps .gitkeep', () => {
    const plan = repo.plan();
    const deleted = plan.changes.filter((entry) => entry.status === 'D').map((entry) => entry.path);
    expect(deleted.filter((path) => path.startsWith('changelog/unreleased/'))).toEqual(
      plan.fragments.map((name) => `changelog/unreleased/${name}`)
    );
    expect(plan.changes.some((entry) => entry.path.endsWith('.gitkeep'))).toBe(false);
  });
});

describe('the 10-version cap', () => {
  it('rolls the oldest section, byte for byte with its link, into a renamed archive', () => {
    const plan = repo.plan();
    const before = repo.read('CHANGELOG.md');
    const text = after(plan, 'CHANGELOG.md');
    expect(text).not.toContain('## [0.14.0]');
    expect(text).not.toContain('[0.14.0]: ');
    expect(text).toContain(
      'Older releases (v0.1.0 – v0.14.0) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.14.0.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.14.0.md).'
    );
    expect(change(plan, 'changelog/archive/CHANGELOG-v0.1.0-to-v0.13.0.md').status).toBe('D');
    const archive = change(plan, 'changelog/archive/CHANGELOG-v0.1.0-to-v0.14.0.md');
    expect(archive.status).toBe('A');
    const moved = before.slice(before.indexOf('## [0.14.0]'), before.indexOf('\nOlder releases'));
    expect(archive.after).toContain(`\n\n${moved}\n## [0.13.0]`);
    expect(archive.after?.split('\n')[0]).toBe('# Changelog archive: v0.1.0 – v0.14.0');
    expect(archive.after).toContain(
      '[0.14.0]: https://github.com/dork-labs/dorkos/compare/v0.13.0...v0.14.0\n[0.13.0]: '
    );
  });

  it("moves the docs page's own copy of the section to the docs archive", () => {
    const plan = repo.plan();
    const page = after(plan, 'docs/changelog.mdx');
    expect(page).not.toContain('## [0.14.0]');
    expect(page).toContain('Older releases (v0.1.0 – v0.14.0) live in the [Changelog archive]');
    const archive = after(plan, 'docs/changelog-archive.mdx');
    expect(archive).toContain('the docs page words this way');
    expect(archive.indexOf('## [0.14.0]')).toBeLessThan(archive.indexOf('## [0.13.0]'));
    expect(archive).toContain('description: Older fixture releases (v0.1.0 – v0.14.0)');
  });

  it('leaves both archives alone when nothing ages out', () => {
    for (const file of ['CHANGELOG.md', 'docs/changelog.mdx']) {
      const text = repo.read(file);
      repo.write(file, text.replace(/## \[0\.14\.0\][\s\S]*?(?=\nOlder releases)/, ''));
    }
    const plan = repo.plan();
    expect(plan.changes.map((entry) => entry.path)).not.toContain('docs/changelog-archive.mdx');
    expect(plan.changes.some((entry) => entry.path.startsWith('changelog/archive/'))).toBe(false);
    expect(after(plan, 'CHANGELOG.md')).toContain('(v0.1.0 – v0.13.0)');
  });

  it('refuses when the docs page and CHANGELOG.md disagree on the versions kept', () => {
    const page = repo.read('docs/changelog.mdx');
    repo.write(
      'docs/changelog.mdx',
      page.replace(/## \[0\.19\.0\][\s\S]*?(?=## \[0\.18\.0\])/, '')
    );
    expect(() => repo.plan()).toThrow(/would list/);
  });
});

describe('the docs page', () => {
  it('gets the same section, escaped for MDX, and no link references', () => {
    const plan = repo.plan();
    const page = after(plan, 'docs/changelog.mdx');
    expect(page).toContain(
      '- A rule can name a person as \\{name}, and a room holds &lt;5 rules (DOR-2).'
    );
    expect(after(plan, 'CHANGELOG.md')).toContain('as {name}, and a room holds <5 rules');
    expect(page).not.toContain('[0.20.1]: ');
  });
});

describe('the outputs', () => {
  it('opens notes.md with the CHANGELOG section verbatim, then the update line and compare link', () => {
    const plan = repo.plan();
    const body = sectionBody(after(plan, 'CHANGELOG.md'), '0.20.1').join('\n');
    expect(plan.notes.startsWith(`${body}\n\n## Update\n`)).toBe(true);
    expect(plan.notes).toContain('npm update -g dorkos');
    expect(plan.notes).toContain('https://github.com/dork-labs/dorkos/compare/v0.20.0...v0.20.1');
  });

  it('lists feat and fix commits that no fragment covers in the PR body', () => {
    const commits = [
      'aaaaaaa1111 fix(chat): keep model settings on the first message (#10)',
      'bbbbbbb2222 feat(rooms): something nobody wrote up (#11)',
      'ccccccc3333 chore(ci): not user-facing (#12)',
      'ddddddd4444 fix(rooms): the rules page names its file',
      'eeeeeee5555 fix(api): name @someone-zz9 in a subject (#13)',
    ].join('\n');
    const plan = repo.plan({ commits });
    expect(plan.unfragmented.map((commit) => commit.sha)).toEqual(['bbbbbbb2222', 'eeeeeee5555']);
    expect(plan.prBody).toContain('- bbbbbbb222 feat(rooms): something nobody wrote up (#11)');
    expect(plan.prBody).toContain('`@someone-zz9`');
    expect(plan.prBody).not.toContain('ccccccc');
  });

  it('counts a commit that added a fragment as covered, whatever its subject', () => {
    const commits = [
      // A squash subject no covers: line names, but the merge added a fragment.
      'aaaaaaa1111 feat(api): name every operation (#4162)\tchangelog/unreleased/261122-x.md\tdocs/a.md',
      // Added files, but no fragment among them.
      'bbbbbbb2222 fix(api): fix a thing (#4163)\tdocs/a.md',
      // A fragment in another folder does not count.
      'ccccccc3333 fix(api): fix another (#4164)\tchangelog/archive/x.md',
    ].join('\n');
    expect(repo.plan({ commits }).unfragmented.map((commit) => commit.sha)).toEqual([
      'bbbbbbb2222',
      'ccccccc3333',
    ]);
    expect(() => repo.plan({ commits: 'aaaaaaa1111 fix(x): y\t\tdocs/a.md' })).toThrow(
      /--commits line 1/
    );
  });

  it('refuses a commits line that is not "<sha> <subject>"', () => {
    expect(() => repo.plan({ commits: 'not a sha line' })).toThrow(/--commits line 1/);
  });
});

describe('the release-branch-contents self-check', () => {
  it('passes the planned commit through checkReleaseCherryPicks', () => {
    const plan = repo.plan();
    const findings = checkReleaseCherryPicks({
      version: plan.version,
      commits: [
        {
          sha: 'a'.repeat(40),
          parents: ['b'.repeat(40)],
          message: `chore(release): v${plan.version}`,
          patchId: undefined,
          files: plan.changes,
        },
      ],
      isMainAncestor: () => false,
      patchIdOf: () => undefined,
      isInBase: () => false,
      isRevertedOnMain: () => false,
    });
    expect(findings).toEqual([]);
    expect(selfCheck(plan)).toEqual([]);
  });

  it('refuses an extra file in the change set', () => {
    const plan = repo.plan();
    const tampered = [
      ...plan.changes,
      {
        path: 'apps/server/src/services/runtimes/shared/awareness/agent-release-notes.ts',
        status: 'M' as const,
        before: "version: 'next'",
        after: `version: '${plan.version}'`,
      },
    ];
    expect(selfCheck({ version: plan.version, changes: tampered }).map((f) => f.code)).toEqual([
      'non-release-file',
    ]);
  });

  it('refuses a reformatted package.json', () => {
    const plan = repo.plan();
    const changes = plan.changes.map((entry) =>
      entry.path === 'package.json'
        ? { ...entry, after: JSON.stringify({ ...JSON.parse(entry.after ?? ''), extra: 1 }) }
        : entry
    );
    expect(selfCheck({ version: plan.version, changes }).map((f) => f.code)).toEqual([
      'release-commit-package-json',
    ]);
  });

  it('refuses a reformatted API document', () => {
    const plan = repo.plan();
    const changes = plan.changes.map((entry) =>
      entry.path === 'docs/api/openapi.json'
        ? { ...entry, after: JSON.stringify(JSON.parse(entry.after ?? '')) }
        : entry
    );
    expect(selfCheck({ version: plan.version, changes }).map((f) => f.code)).toEqual([
      'non-release-file',
    ]);
  });
});
