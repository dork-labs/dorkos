import { describe, expect, it } from 'vitest';
import {
  assertBaseIsAncestor,
  assertHotfixBaseTag,
  assertReleaseBranchName,
  assertReleaseBranchTip,
  assertReleaseCherryPicks,
  assertRoutineBase,
  assertVersionOnNpm,
  checkReleaseCherryPicks,
  formatReleaseBranchLog,
  resolveTagCommit,
  type ReleaseBranchCommit,
} from '../../scripts/release-branch/rules.js';
import { parseReleaseBranchArgs } from '../../scripts/release-branch/proof.js';
import {
  assertPublishApproval,
  assertTarballManifest,
  tarballIntegrity,
} from '../../scripts/release-branch/publish-gate.js';

// Made-up SHAs; shapes copied from real `gh api` responses.
const sha = (c: string) => c.repeat(40);
const head = sha('a');
const pin = sha('b');
const source = sha('c');
const branch = 'release/v1.2.3';
const branchJson = (tip: string) => ({
  name: branch,
  commit: { sha: tip, url: `https://api.github.com/repos/acme/app/commits/${tip}` },
  protected: true,
});

describe('branch name', () => {
  it('accepts exactly release/v<version>', () => {
    expect(() => assertReleaseBranchName(branch, '1.2.3')).not.toThrow();
  });
  it.each([
    ['release/1.2.3', '1.2.3'],
    ['release/v1.2.4', '1.2.3'],
    ['release/v01.2.3', '01.2.3'],
    ['release/v1.2.3-rc.1', '1.2.3-rc.1'],
    ['release/v1.2.3/x', '1.2.3'],
    ['feature/v1.2.3', '1.2.3'],
  ])('refuses %s for %s', (name, version) => {
    expect(() => assertReleaseBranchName(name, version)).toThrow('exactly release/v<version>');
  });
});

describe('branch tip', () => {
  it('accepts a tip equal to the release commit and the named SHA', () => {
    expect(() => assertReleaseBranchTip(branchJson(head), branch, head, head)).not.toThrow();
  });
  it('refuses a cherry-pick that landed after the OK (tip moved past the named SHA)', () => {
    const later = sha('d');
    expect(() => assertReleaseBranchTip(branchJson(later), branch, later, head)).toThrow(
      'landed after their OK'
    );
  });
  it('refuses a local commit that is not the trusted tip', () => {
    expect(() => assertReleaseBranchTip(branchJson(sha('d')), branch, head, head)).toThrow(
      'not the current tip'
    );
  });
  it.each([
    ['another branch', { ...branchJson(head), name: 'main' }],
    ['no commit', { name: branch }],
    ['short sha', branchJson('abc123')],
    ['not an object', []],
  ])('refuses %s', (_, value) => {
    expect(() => assertReleaseBranchTip(value, branch, head, head)).toThrow('unavailable');
  });
});

describe('bases', () => {
  it("routine: the merge-base must be QA's pin", () => {
    expect(() => assertRoutineBase(pin, pin)).not.toThrow();
    expect(() => assertRoutineBase(sha('e'), pin)).toThrow("not at QA's pin");
  });
  it('hotfix: the base tag must be the previous patch', () => {
    expect(() => assertHotfixBaseTag('v1.2.2', '1.2.3')).not.toThrow();
    for (const tag of ['v1.2.1', 'v1.1.2', '1.2.2', 'v1.2.3', 'v1.2.2-rc.1', 'main'])
      expect(() => assertHotfixBaseTag(tag, '1.2.3')).toThrow('previous patch tag');
    expect(() => assertHotfixBaseTag('v1.2.0', '1.2.0')).toThrow('previous patch tag');
  });
  it('resolves lightweight and annotated tags to their commit', () => {
    expect(
      resolveTagCommit('v1.2.2', {
        ref: 'refs/tags/v1.2.2',
        object: { type: 'commit', sha: pin },
      })
    ).toBe(pin);
    const tagObject = sha('f');
    expect(
      resolveTagCommit(
        'v1.2.2',
        { ref: 'refs/tags/v1.2.2', object: { type: 'tag', sha: tagObject } },
        { sha: tagObject, tag: 'v1.2.2', object: { type: 'commit', sha: pin } }
      )
    ).toBe(pin);
  });
  it.each([
    ['a branch, not a tag', { ref: 'refs/heads/v1.2.2', object: { type: 'commit', sha: pin } }],
    [
      'an annotated tag with no object read',
      { ref: 'refs/tags/v1.2.2', object: { type: 'tag', sha: pin } },
    ],
    ['a tree', { ref: 'refs/tags/v1.2.2', object: { type: 'tree', sha: pin } }],
  ])('refuses %s', (_, ref) => {
    expect(() => resolveTagCommit('v1.2.2', ref)).toThrow('could not be resolved');
  });
  it('refuses a ref that is neither a commit nor a tag, even with a tag-shaped object', () => {
    const tagObject = sha('f');
    expect(() =>
      resolveTagCommit(
        'v1.2.2',
        { ref: 'refs/tags/v1.2.2', object: { type: 'blob', sha: tagObject } },
        { sha: tagObject, tag: 'v1.2.2', object: { type: 'commit', sha: pin } }
      )
    ).toThrow('could not be resolved');
  });
  it('refuses an annotated tag that points at another tag', () => {
    const tagObject = sha('f');
    expect(() =>
      resolveTagCommit(
        'v1.2.2',
        { ref: 'refs/tags/v1.2.2', object: { type: 'tag', sha: tagObject } },
        { sha: tagObject, tag: 'v1.2.2', object: { type: 'tag', sha: pin } }
      )
    ).toThrow('could not be resolved');
  });
  it('requires the base version on npm', () => {
    expect(() => assertVersionOnNpm('"1.2.2"', '1.2.2')).not.toThrow();
    expect(() => assertVersionOnNpm('', '1.2.2')).toThrow('not on npm');
    expect(() => assertVersionOnNpm('{"error":{"code":"E404"}}', '1.2.2')).toThrow('not on npm');
  });
  it('requires the base tag to be an ancestor of the release commit', () => {
    const compare = {
      status: 'ahead',
      ahead_by: 2,
      behind_by: 0,
      base_commit: { sha: pin },
      merge_base_commit: { sha: pin },
    };
    expect(() => assertBaseIsAncestor(pin, head, compare)).not.toThrow();
    expect(() =>
      assertBaseIsAncestor(pin, head, { ...compare, status: 'diverged', behind_by: 1 })
    ).toThrow('does not descend');
    expect(() =>
      assertBaseIsAncestor(pin, head, { ...compare, merge_base_commit: { sha: sha('e') } })
    ).toThrow('does not descend');
  });
});

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'dorkos', version, license: 'MIT', ...extra }, null, 2) + '\n';
const releaseCommit = (files: ReleaseBranchCommit['files']): ReleaseBranchCommit => ({
  sha: head,
  parents: [sha('9')],
  message: 'chore(release): v1.2.3',
  patchId: sha('7'),
  files,
});
const pick = (overrides: Partial<ReleaseBranchCommit> = {}): ReleaseBranchCommit => ({
  sha: sha('8'),
  parents: [pin],
  message: `fix(x): y (#12)\n\n(cherry picked from commit ${source})`,
  patchId: sha('6'),
  files: [{ path: 'apps/server/src/x.ts', status: 'M' }],
  ...overrides,
});
const input = (commits: ReleaseBranchCommit[], onMain = [source], patch = sha('6')) => ({
  version: '1.2.3',
  commits,
  isMainAncestor: (s: string) => onMain.includes(s),
  patchIdOf: (s: string) => (onMain.includes(s) ? patch : undefined),
});
const fullRelease = releaseCommit([
  { path: 'VERSION', status: 'M', before: '1.2.2\n', after: '1.2.3\n' },
  { path: 'CHANGELOG.md', status: 'M' },
  { path: 'docs/changelog.mdx', status: 'M' },
  { path: 'packages/cli/package.json', status: 'M', before: pkg('1.2.2'), after: pkg('1.2.3') },
  { path: 'changelog/unreleased/261118-000000-fix.md', status: 'D' },
  { path: 'blog/dorkos-1-2-3.mdx', status: 'A' },
  { path: 'apps/site/public/product/archive/v1.2.3/hero.png', status: 'A' },
  { path: 'changelog/archive/CHANGELOG-v0.1.0-to-v1.2.1.md', status: 'D' },
  { path: 'changelog/archive/CHANGELOG-v0.1.0-to-v1.2.2.md', status: 'A' },
]);

describe('cherry-pick rule', () => {
  it('accepts clean picks of main commits plus the release commit', () => {
    expect(checkReleaseCherryPicks(input([pick(), fullRelease]))).toEqual([]);
    expect(() => assertReleaseCherryPicks(input([pick(), fullRelease]))).not.toThrow();
  });
  it('refuses a commit that is neither a pick nor release-only', () => {
    const stray = releaseCommit([{ path: 'apps/server/src/x.ts', status: 'M' }]);
    expect(checkReleaseCherryPicks(input([stray]))).toEqual([
      {
        sha: head,
        code: 'non-release-file',
        detail: expect.stringContaining('apps/server/src/x.ts is not a release file'),
      },
    ]);
  });
  it('refuses a pick whose patch-id differs from its source', () => {
    expect(checkReleaseCherryPicks(input([pick()], [source], sha('5')))[0]?.code).toBe(
      'patch-id-mismatch'
    );
    expect(checkReleaseCherryPicks(input([pick({ patchId: undefined })]))[0]?.code).toBe(
      'patch-id-mismatch'
    );
  });
  it('refuses a pick whose source is not on main', () => {
    expect(checkReleaseCherryPicks(input([pick()], []))[0]?.code).toBe('source-not-on-main');
  });
  it('refuses a pick naming two sources, and a merge commit', () => {
    const two = `${pick().message}\n(cherry picked from commit ${sha('4')})`;
    expect(checkReleaseCherryPicks(input([pick({ message: two })]))[0]?.code).toBe(
      'multiple-sources'
    );
    expect(checkReleaseCherryPicks(input([pick({ parents: [pin, sha('4')] })]))[0]?.code).toBe(
      'not-linear'
    );
  });
  it('refuses an empty range unless asked to allow one', () => {
    expect(checkReleaseCherryPicks(input([]))[0]?.code).toBe('no-commits');
    expect(checkReleaseCherryPicks({ ...input([]), allowEmpty: true })).toEqual([]);
    expect(checkReleaseCherryPicks(input([releaseCommit([])]))[0]?.code).toBe('empty-commit');
  });
  it.each([
    [
      'a package.json change beyond version',
      'packages/cli/package.json',
      pkg('1.2.2'),
      pkg('1.2.3', { dependencies: { evil: '1' } }),
    ],
    [
      'a package.json version for another release',
      'packages/cli/package.json',
      pkg('1.2.2'),
      pkg('1.2.4'),
    ],
    [
      'a package.json the release never bumps',
      'packages/shared/package.json',
      pkg('1.2.2'),
      pkg('1.2.3'),
    ],
    ['a VERSION for another release', 'VERSION', '1.2.2\n', '1.2.4\n'],
    [
      'a new postinstall script',
      'packages/cli/package.json',
      pkg('1.2.2'),
      pkg('1.2.3', { scripts: { postinstall: 'node x.js' } }),
    ],
    [
      'a changed bin',
      'packages/cli/package.json',
      pkg('1.2.2', { bin: { dorkos: 'a.js' } }),
      pkg('1.2.3', { bin: { dorkos: 'b.js' } }),
    ],
    [
      'changed exports',
      'packages/cloud-api/package.json',
      pkg('1.2.2', { exports: { '.': './a.js' } }),
      pkg('1.2.3', { exports: { '.': './b.js' } }),
    ],
    [
      'changed files',
      'packages/connector-providers/package.json',
      pkg('1.2.2', { files: ['dist'] }),
      pkg('1.2.3', { files: ['dist', 'src'] }),
    ],
    [
      'a changed publishConfig',
      'packages/cloud-api/package.json',
      pkg('1.2.2'),
      pkg('1.2.3', { publishConfig: { registry: 'https://example.com' } }),
    ],
    ['a package.json that is not JSON', 'package.json', pkg('1.2.2'), '{'],
  ])('refuses a release commit with %s', (_, path, before, after) => {
    const commit = releaseCommit([{ path, status: 'M', before, after }]);
    const code = /packages\/(cli|cloud-api|connector-providers)\/|^package\.json$/.test(path)
      ? 'release-commit-package-json'
      : 'non-release-file';
    expect(checkReleaseCherryPicks(input([commit]))[0]).toMatchObject({
      code,
      detail: expect.stringContaining(path),
    });
  });
  it.each([
    ['an added fragment', 'changelog/unreleased/x.md', 'A'],
    ['another release blog post', 'blog/dorkos-1-2-4.mdx', 'A'],
    ['another release media archive', 'apps/site/public/product/archive/v1.2.4/x.png', 'A'],
    ['a deleted changelog', 'CHANGELOG.md', 'D'],
    ['a workflow', '.github/workflows/release-publish.yml', 'M'],
    ['a lockfile change', 'pnpm-lock.yaml', 'M'],
    ['a release script', 'scripts/release.ts', 'M'],
    ['a CLI release script', 'packages/cli/scripts/release-cli.ts', 'M'],
    ['an agent tool file', '.agents/skills/x/SKILL.md', 'M'],
    ['a renamed-in fragment', 'changelog/unreleased/x.md', 'R'],
    ['a changed archive file', 'changelog/archive/CHANGELOG-v0.1.0-to-v1.2.2.md', 'M'],
    ['another archive file', 'changelog/archive/notes.md', 'A'],
  ] as const)('refuses a release commit with %s', (_, path, status) => {
    const forbidden = /^(\.github|\.agents|scripts|packages\/cli\/scripts)\/|^pnpm-lock/.test(path);
    expect(checkReleaseCherryPicks(input([releaseCommit([{ path, status }])]))[0]?.code).toBe(
      forbidden ? 'release-commit-forbidden-path' : 'non-release-file'
    );
  });
  it('names every bad commit in one error', () => {
    const stray = { ...releaseCommit([{ path: 'x.ts', status: 'A' }]), sha: sha('3') };
    expect(() => assertReleaseCherryPicks(input([stray, pick({ patchId: sha('1') })]))).toThrow(
      /333333333333 \[non-release-file\].*\n.*888888888888 \[patch-id-mismatch\]/
    );
  });
});

describe('publish log', () => {
  it('prints the base, the branch, the diff stat and the commit list', () => {
    const log = formatReleaseBranchLog({
      mode: 'routine',
      base: pin,
      baseLabel: "QA's pin on main",
      branch,
      head,
      diffStat: ' VERSION | 2 +-',
      log: 'aaaaaaa chore(release): v1.2.3',
    });
    expect(log).toContain(`base:   QA's pin on main (${pin})`);
    expect(log).toContain(`branch: ${branch}`);
    expect(log).toContain(`git diff --stat ${pin}..${head}\n VERSION | 2 +-`);
    expect(log).toContain(`git log --oneline ${pin}..${head}\naaaaaaa chore(release): v1.2.3`);
  });
});

describe('release-cli flags', () => {
  const flags = [
    '--release-branch',
    branch,
    '--mode',
    'routine',
    '--base',
    pin,
    '--expected-sha',
    head,
  ];
  it('leaves the no-flag path untouched', () => {
    expect(parseReleaseBranchArgs([])).toBeUndefined();
    expect(parseReleaseBranchArgs(['--publish'])).toBeUndefined();
  });
  it('parses a full routine or hotfix set', () => {
    expect(parseReleaseBranchArgs([...flags, '--root', '/tmp/r'])).toEqual({
      request: { branch, mode: 'routine', base: pin, expectedSha: head },
      root: '/tmp/r',
      rest: [],
    });
    const hotfix = [...flags.slice(0, 3), 'hotfix', '--base', 'v1.2.2', '--expected-sha', head];
    expect(parseReleaseBranchArgs(hotfix)?.request.mode).toBe('hotfix');
  });
  it.each([
    ['a missing flag', flags.slice(0, 6)],
    ['a bad mode', [...flags.slice(0, 3), 'yolo', ...flags.slice(4)]],
    ['a short expected SHA', [...flags.slice(0, 7), 'abc']],
    ['a tag as the routine base', [...flags.slice(0, 5), 'v1.2.2', ...flags.slice(6)]],
    ['a repeated flag', [...flags, '--mode', 'hotfix']],
    ['a flag with no value', [...flags.slice(0, 7), '--root']],
  ])('refuses %s', (_, args) => {
    expect(() => parseReleaseBranchArgs(args)).toThrow();
  });
});

const approval = (login: string, state = 'approved', env = 'npm-release', id = 7) => ({
  environments: [{ id: 1, name: env, url: 'https://api.github.com/repos/acme/app/environments/x' }],
  state,
  user: { login, id, type: 'User' },
  comment: 'Ship it',
});
const approver = { login: 'release-approver', id: 7 };

describe('publish approval', () => {
  it('accepts an npm-release approval by the named approver', () => {
    expect(() =>
      assertPublishApproval([approval('Release-Approver')], approver, 'dev-account')
    ).not.toThrow();
  });
  it.each([
    ['no approvals', []],
    ['an approval for another environment', [approval('release-approver', 'approved', 'staging')]],
    ['an approval by someone else', [approval('dev-account', 'approved', 'npm-release', 8)]],
    ['a rejection', [approval('release-approver', 'rejected')]],
    [
      'an extra approval by someone else',
      [approval('release-approver'), approval('dev-account', 'approved', 'npm-release', 8)],
    ],
    [
      'the right login on another account (a reclaimed login)',
      [approval('release-approver', 'approved', 'npm-release', 99)],
    ],
    ['not a list', { total_count: 0 }],
  ])('refuses %s', (_, value) => {
    expect(() => assertPublishApproval(value, approver, 'dev-account')).toThrow();
  });
  it('refuses when the run was started by the approver account', () => {
    expect(() =>
      assertPublishApproval([approval('release-approver')], approver, 'Release-Approver')
    ).toThrow('cannot also be its approver');
  });
  it('refuses the placeholder and malformed approvers', () => {
    for (const bad of [
      { login: '<approver-not-named-yet>', id: 7 },
      { login: 'release-approver', id: 0 },
      { login: '', id: 7 },
      { login: 'a b', id: 7 },
    ])
      expect(() =>
        assertPublishApproval([approval('release-approver')], bad, 'dev-account')
      ).toThrow('GitHub accounts');
  });
});

describe('tarball integrity', () => {
  it("matches npm's dist.integrity form", () => {
    // sha512 of the empty input, base64, as npm prints it.
    expect(tarballIntegrity(new Uint8Array())).toBe(
      'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='
    );
  });
});

describe('tarball manifest', () => {
  it('requires the exact package and version', () => {
    expect(() => assertTarballManifest(pkg('1.2.3'), 'dorkos', '1.2.3')).not.toThrow();
    expect(() => assertTarballManifest(pkg('1.2.4'), 'dorkos', '1.2.3')).toThrow(
      'not dorkos@1.2.3'
    );
    expect(() => assertTarballManifest(pkg('1.2.3'), '@dork-labs/cloud-api', '1.2.3')).toThrow();
    expect(() => assertTarballManifest('nope', 'dorkos', '1.2.3')).toThrow();
  });
});
