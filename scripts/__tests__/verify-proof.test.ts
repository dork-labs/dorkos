import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVerification } from '../verify-proof/cli.ts';

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
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROOF_TEST_EXIT: status },
      });
    expect(run('0').status).toBe(0);
    expect(check().status).toBe(0);
    expect(readFileSync(path.join(repo, '.git/gate-runs'), 'utf8')).toBe('run verify:checks\n');
    expect(run('8').status).toBe(8);
    expect(check().status).toBe(1);
    expect(readFileSync(path.join(repo, '.git/gate-runs'), 'utf8')).toBe(
      'run verify:checks\nrun verify:checks\n'
    );
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

  it('allows the explicit escape and logs who, when, and the exact SHA', () => {
    expect(check('--no-verify-proof').status).toBe(0);
    const log = readFileSync(path.join(repo, '.git/dorkos-verify-proof/escapes.jsonl'), 'utf8');
    const record = JSON.parse(log.trim());
    expect(record).toMatchObject({ sha, who: 'Test Founder' });
    expect(Number.isNaN(Date.parse(record.when))).toBe(false);
    expect(check().status).toBe(1);
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
