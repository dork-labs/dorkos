import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitPatchId,
  proveReleaseBranch,
  type ReleaseBranchReads,
} from '../../scripts/release-branch/proof.js';

// The whole proof, end to end: real git on a throwaway repo with made-up
// content, and recorded-shape `gh api` and npm answers in place of the network.
let repo = '';
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
const write = (file: string, body: string) => writeFile(join(repo, file), body);
const commitAll = (message: string) => {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};
const pkg = (version: string) => JSON.stringify({ name: 'dorkos', version }, null, 2) + '\n';
const REPO = 'acme/app';
const branch = 'release/v1.2.3';
let pin = '';
let fix = '';
let mainTip = '';
let head = '';

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'release-branch-proof-'));
  git('init', '-q', '-b', 'main');
  await write('VERSION', '1.2.2\n');
  await write('package.json', pkg('1.2.2'));
  await write('app.ts', 'export const a = 1;\n');
  pin = commitAll('feat: app');
  await write('other.ts', 'export const b = 1;\n');
  commitAll('feat: after the pin');
  await write('app.ts', 'export const a = 2;\n');
  fix = commitAll('fix: a is two (#7)');
  mainTip = fix;
  git('switch', '-q', '-c', branch, pin);
  git('cherry-pick', '-x', fix);
  await write('VERSION', '1.2.3\n');
  await write('package.json', pkg('1.2.3'));
  head = commitAll('chore(release): v1.2.3');
});
afterAll(() => rm(repo, { recursive: true, force: true }));

function reads(overrides: { tip?: string; npm?: string; compareBehind?: number } = {}) {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    [`repos/${REPO}`]: { full_name: REPO, default_branch: 'main' },
    [`repos/${REPO}/branches/main`]: { name: 'main', commit: { sha: mainTip } },
    [`repos/${REPO}/branches/${branch}`]: {
      name: branch,
      commit: { sha: overrides.tip ?? head },
      protected: true,
    },
    [`repos/${REPO}/git/ref/tags/v1.2.2`]: {
      ref: 'refs/tags/v1.2.2',
      object: { type: 'commit', sha: pin },
    },
    [`repos/${REPO}/compare/${pin}...${head}`]: {
      status: 'ahead',
      ahead_by: 2,
      behind_by: overrides.compareBehind ?? 0,
      base_commit: { sha: pin },
      merge_base_commit: { sha: pin },
    },
  };
  const io: ReleaseBranchReads = {
    api: (path) => {
      calls.push(path);
      if (!(path in answers)) throw Error(`unexpected gh api ${path}`);
      return answers[path];
    },
    npmView: (spec) => (spec === 'dorkos@1.2.2' ? (overrides.npm ?? '"1.2.2"') : ''),
    fetchMain: () => {},
  };
  return { io, calls };
}
const prove = (
  mode: 'routine' | 'hotfix',
  base: string,
  io: ReleaseBranchReads,
  expectedSha = head
) =>
  proveReleaseBranch({
    root: repo,
    repository: REPO,
    version: '1.2.3',
    head,
    request: { branch, mode, base, expectedSha },
    reads: io,
  });

describe('routine', () => {
  it('passes a pick plus the release commit cut at the pin, and logs what ships', () => {
    const log = prove('routine', pin, reads().io);
    expect(log).toContain(`base:   QA's pin on main (${pin})`);
    expect(log).toContain('fix: a is two (#7)');
    expect(log).toContain('chore(release): v1.2.3');
    expect(log).toMatch(/app\.ts\s+\| 2 \+-/);
  });
  it('refuses a cut that is not at the pin', () => {
    expect(() => prove('routine', fix, reads().io)).toThrow("not at QA's pin");
  });
  it('refuses when the tip moved after the OK', () => {
    expect(() => prove('routine', pin, reads({ tip: fix }).io)).toThrow('not the current tip');
    expect(() => prove('routine', pin, reads().io, fix)).toThrow('landed after their OK');
  });
});

describe('hotfix', () => {
  it('reads the tag, npm and the ancestry from GitHub', () => {
    const { io, calls } = reads();
    expect(prove('hotfix', 'v1.2.2', io)).toContain('base:   published tag v1.2.2');
    expect(calls).toContain(`repos/${REPO}/git/ref/tags/v1.2.2`);
    expect(calls).toContain(`repos/${REPO}/compare/${pin}...${head}`);
  });
  it('refuses a base not on npm, or not an ancestor', () => {
    expect(() => prove('hotfix', 'v1.2.2', reads({ npm: '' }).io)).toThrow('not on npm');
    expect(() => prove('hotfix', 'v1.2.2', reads({ compareBehind: 1 }).io)).toThrow(
      'does not descend'
    );
  });
});

it('runs the cherry-pick rule over every commit: a stray commit refuses both modes', async () => {
  const saved = head;
  await write('app.ts', 'export const a = 3;\n');
  head = commitAll('fix: only on the branch');
  try {
    expect(() => prove('routine', pin, reads().io)).toThrow(/non-release-file/);
    expect(() => prove('hotfix', 'v1.2.2', reads().io)).toThrow(/non-release-file/);
  } finally {
    git('reset', '-q', '--hard', saved);
    head = saved;
  }
});

it('fingerprints a file-to-symlink change, and a clean pick of it matches', async () => {
  git('switch', '-q', 'main');
  await unlink(join(repo, 'other.ts'));
  await symlink('app.ts', join(repo, 'other.ts'));
  const source = commitAll('refactor: other is a link');
  // Pick it onto a different base: the parent plus an unrelated commit.
  git('switch', '-q', '-c', 'scratch', `${source}^`);
  await write('unrelated.ts', 'export const u = 1;\n');
  commitAll('feat: unrelated');
  git('cherry-pick', '-x', source);
  const picked = git('rev-parse', 'HEAD');
  expect(gitPatchId(repo, source)).toBeDefined();
  expect(gitPatchId(repo, picked)).toBe(gitPatchId(repo, source));
  git('switch', '-q', branch);
});

describe('check-picks shell entry', () => {
  const script = fileURLToPath(
    new URL('../../scripts/release-branch/check-picks.ts', import.meta.url)
  );
  const runCheck = (...args: string[]) =>
    spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], {
      encoding: 'utf8',
    });
  it('exits 0 with ok JSON on a clean branch', () => {
    const result = runCheck(repo, '1.2.3', pin, head, mainTip);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, findings: [] });
  });
  it('exits 1 with coded findings on a stray commit', async () => {
    const saved = head;
    await write('app.ts', 'export const a = 4;\n');
    const stray = commitAll('fix: only on the branch');
    try {
      const result = runCheck(repo, '1.2.3', pin, stray, mainTip);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).findings[0]).toMatchObject({
        sha: stray,
        code: 'non-release-file',
      });
    } finally {
      git('reset', '-q', '--hard', saved);
    }
  });
  it('exits 2 on bad arguments, and fails closed on an empty range', () => {
    expect(runCheck(repo, '1.2.3', pin).status).toBe(2);
    expect(runCheck(repo, '1.2.3', 'main', head, mainTip).status).toBe(2);
    // head..head with a different base claimed would be a short read: base must equal head to pass empty.
    const empty = runCheck(repo, '1.2.3', head, head, mainTip);
    expect(empty.status).toBe(0);
    const shortRead = runCheck(repo, '1.2.3', fix, pin, mainTip);
    expect(shortRead.status).toBe(1);
    expect(JSON.parse(shortRead.stdout).findings[0].code).toBe('no-commits');
  });
});
