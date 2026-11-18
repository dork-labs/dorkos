import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBinaryTestGlobs, runVerification } from '../verify-proof/cli.ts';

const script = path.resolve(import.meta.dirname, '../verify-proof/cli.ts');
let repo: string;
let sha: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
const check = (...args: string[]) =>
  spawnSync(process.execPath, [script, 'check', sha, ...args], { cwd: repo, encoding: 'utf8' });
const refusal = () =>
  `no pnpm verify pass recorded for ${sha.slice(0, 12)}; run pnpm verify, or pass --no-verify-proof\n`;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'verify-proof-'));
  git('init', '-q');
  git('config', 'user.name', 'Test Founder');
  git('config', 'user.email', 'founder@example.test');
  writeFileSync(path.join(repo, 'example.txt'), 'original');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  sha = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('verification proof', () => {
  it('wires pnpm verify through the wrapper without changing the checks', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')
    );
    expect(pkg.scripts.verify).toBe('node scripts/verify-proof/cli.ts run');
    expect(pkg.scripts['verify:checks']).toContain('pnpm test:scripts && pnpm lint:root');
  });

  it('runs the checks exactly once through the CLI and preserves a failed exit', () => {
    const bin = path.join(repo, '.git/bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, 'pnpm'),
      '#!/bin/sh\necho "$*" >> .git/gate-runs\nexit "${PROOF_TEST_EXIT:-0}"\n',
      { mode: 0o755 }
    );
    const run = (status: string) =>
      spawnSync(process.execPath, [script, 'run'], {
        cwd: repo,
        encoding: 'utf8',
        // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROOF_TEST_EXIT: status },
      });
    // The host-binary suites are left to CI: every glob in the data file rides as an exclude.
    const globs = readBinaryTestGlobs(path.resolve(import.meta.dirname, '../..'));
    const gateRun = `run verify:checks ${globs.map((glob) => `--exclude=${glob}`).join(' ')}\n`;
    expect(run('0').status).toBe(0);
    expect(check().status).toBe(0);
    expect(readFileSync(path.join(repo, '.git/gate-runs'), 'utf8')).toBe(gateRun);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof.excluded).toEqual(globs);
    expect(run('8').status).toBe(8);
    expect(check().status).toBe(1);
    expect(readFileSync(path.join(repo, '.git/gate-runs'), 'utf8')).toBe(gateRun + gateRun);
  });

  it('records exactly the excludes it handed to the checks', () => {
    const excluded = ['**/fixture/**/*.binary.test.ts', '**/other/*.binary.test.ts'];
    let seen: readonly string[] | undefined;
    expect(
      runVerification(
        repo,
        (globs) => {
          seen = globs;
          return 0;
        },
        excluded
      )
    ).toBe(0);
    expect(seen).toEqual(excluded);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof).toEqual({
      sha,
      tree: git('rev-parse', `${sha}^{tree}`),
      excluded,
      passedAt: expect.any(String),
    });
    expect(check().status).toBe(0);
  });

  it('records an empty exclusion list when nothing was left out', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof.excluded).toEqual([]);
  });

  it('accepts an older proof with no exclusion list, since it left nothing out', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    const { excluded: _excluded, ...older } = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, JSON.stringify(older));
    expect(check().status).toBe(0);
  });

  it('reads globs one per line, skipping blank lines and comments', () => {
    mkdirSync(path.join(repo, 'scripts/ci'), { recursive: true });
    writeFileSync(
      path.join(repo, 'scripts/ci/binary-test-glob.txt'),
      '# why these are left to CI\n\n  **/a/*.binary.test.ts  \n**/b/*.binary.test.ts\n'
    );
    expect(readBinaryTestGlobs(repo)).toEqual(['**/a/*.binary.test.ts', '**/b/*.binary.test.ts']);
  });

  it('refuses extra arguments to run before any check starts', () => {
    const result = spawnSync(process.execPath, [script, 'run', '--force'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^pnpm verify takes no arguments \(got: --force\);/);
    expect(existsSync(path.join(repo, '.git/dorkos-verify-proof'))).toBe(false);
  });

  it('refuses a missing record with exactly one actionable line', () => {
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal());
    expect(result.stdout).toBe('');
  });

  it('refuses a record for another tree', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    const record = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, JSON.stringify({ ...record, tree: '0'.repeat(40) }));
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });

  it('allows a matching record and shares it with another worktree', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    expect(check().status).toBe(0);
    const sibling = path.join(repo, 'sibling');
    git('worktree', 'add', '--detach', sibling, sha);
    writeFileSync(path.join(sibling, 'other-work.txt'), 'unrelated work');
    const result = spawnSync(process.execPath, [script, 'check', sha], {
      cwd: sibling,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('allows the explicit escape and logs who, when, the full SHA, and its tree', () => {
    const escaped = spawnSync(process.execPath, [script, 'check', sha, '--no-verify-proof'], {
      cwd: repo,
      encoding: 'utf8',
      // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
      env: { ...process.env, USER: 'test-operator' },
    });
    expect(escaped.status).toBe(0);
    const log = readFileSync(path.join(repo, '.git/dorkos-verify-proof/escapes.jsonl'), 'utf8');
    const record = JSON.parse(log.trim());
    expect(record).toEqual({
      sha,
      tree: git('rev-parse', `${sha}^{tree}`),
      who: 'Test Founder',
      user: 'test-operator',
      when: expect.any(String),
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(record.when))).toBe(false);
    expect(check().status).toBe(1);
  });

  it('refuses the escape when the git user is unknown, and logs nothing', () => {
    git('config', '--unset', 'user.name');
    const result = spawnSync(process.execPath, [script, 'check', sha, '--no-verify-proof'], {
      cwd: repo,
      encoding: 'utf8',
      // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal());
    expect(existsSync(path.join(repo, '.git/dorkos-verify-proof/escapes.jsonl'))).toBe(false);
  });

  it.each([
    ['corrupt JSON', '{"sha":'],
    ['a JSON null', 'null'],
    ['an empty file', ''],
    [
      'an unparseable pass time',
      (record: object) => JSON.stringify({ ...record, passedAt: 'soon' }),
    ],
    ['another commit', (record: object) => JSON.stringify({ ...record, sha: 'f'.repeat(40) })],
    [
      'an exclusion list that is not a list of globs',
      (record: object) => JSON.stringify({ ...record, excluded: '**/*.binary.test.ts' }),
    ],
  ])('refuses a proof file holding %s', (_label, contents) => {
    expect(runVerification(repo, () => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    const record = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, typeof contents === 'string' ? contents : contents(record));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal());
  });

  it('refuses a proof path it cannot read as a file', () => {
    mkdirSync(path.join(repo, '.git/dorkos-verify-proof', sha), { recursive: true });
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });

  it('refuses a ref that is not a commit', () => {
    sha = 'not-a-ref';
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });

  it('judges valid proof the same from a checkout with unrelated edits', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    // The arm script checks from the main checkout, which carries other people's edits.
    writeFileSync(path.join(repo, 'example.txt'), 'someone else is mid-edit');
    writeFileSync(path.join(repo, 'scratch.txt'), 'untracked');
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('records nothing for a dirty starting tree even if checks clean it', () => {
    writeFileSync(path.join(repo, 'example.txt'), 'dirty');
    expect(
      runVerification(repo, () => {
        writeFileSync(path.join(repo, 'example.txt'), 'original');
        return 0;
      })
    ).toBe(0);
    expect(check().status).toBe(1);
  });

  it('records nothing if files change during checks', () => {
    expect(
      runVerification(repo, () => {
        writeFileSync(path.join(repo, 'example.txt'), 'changed');
        return 0;
      })
    ).toBe(0);
    writeFileSync(path.join(repo, 'example.txt'), 'original');
    expect(check().status).toBe(1);
  });

  it('records nothing if HEAD changes during checks', () => {
    expect(
      runVerification(repo, () => {
        git('commit', '--allow-empty', '-qm', 'new head');
        return 0;
      })
    ).toBe(0);
    expect(check().status).toBe(1);
    sha = git('rev-parse', 'HEAD');
    expect(check().status).toBe(1);
  });

  it('preserves failure and invalidates an older pass', () => {
    expect(runVerification(repo, () => 0)).toBe(0);
    expect(runVerification(repo, () => 7)).toBe(7);
    expect(check().status).toBe(1);
  });

  it('records no proof for untracked source and invalidates the older pass', () => {
    runVerification(repo, () => 0);
    writeFileSync(path.join(repo, 'untracked.txt'), 'new source');
    expect(runVerification(repo, () => 0)).toBe(0);
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });
});
