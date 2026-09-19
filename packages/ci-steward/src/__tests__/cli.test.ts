/**
 * The command line, end to end: exit codes, the git-backed coverage mode, the
 * ledger scaffold, and one run through the real `node` binary, which proves
 * Node executes the TypeScript source directly (no build, no loader flag).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.ts';
import { baseSpec, ledgerEntry, writeRepo } from './fixture.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'cli.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(argv: string[], cwd: string) {
  let out = '';
  let err = '';
  const code = main(argv, { out: (s) => (out += s), err: (s) => (err += s) }, cwd);
  return { code, out, err };
}

function fixture() {
  const root = writeRepo(baseSpec());
  dirs.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('ci-steward cli', () => {
  it('exits 0 on a clean census and 1 with findings, finding the root from a subdirectory', () => {
    const root = fixture();
    expect(run(['census', '--now', '2026-09-20T00:00:00Z'], path.join(root, 'ci'))).toMatchObject({
      code: 0,
      out: 'ci-steward census: ok\n',
    });
    const wf = path.join(root, '.github/workflows/lint.yml');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace(/^ *timeout-minutes: 15\n/m, ''));
    const failed = run(['census'], root);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('FAIL [timeout/missing] .github/workflows/lint.yml (job lint)');
  });

  it('prints help with exit 0, and usage with exit 2 when no command is given', () => {
    const root = fixture();
    const help = run(['ledger-new', '--help'], root);
    expect(help.code).toBe(0);
    expect(help.out).toContain('ledger-new --slug <kebab-slug>');
    expect(run(['--help'], root).code).toBe(0);
    expect(run([], root)).toMatchObject({ code: 2, out: '' });
  });

  it('exits 2 on bad usage', () => {
    const root = fixture();
    expect(run(['nope'], root).code).toBe(2);
    expect(run(['census', '--now', 'yesterday'], root).code).toBe(2);
    expect(run(['ledger-check', '--coverage'], root).code).toBe(2);
    expect(run(['census'], path.parse(root).root).code).toBe(2);
  });

  it('ledger-new writes a scaffold with a fresh id, bumping past an id already taken', () => {
    const root = fixture();
    const now = ['--now', '2026-09-20T08:30:00Z'];
    const first = run(['ledger-new', '--slug', 'shard-lint', ...now], root);
    const second = run(['ledger-new', '--slug', 'cache-turbo', '--kind', 'hygiene', ...now], root);
    expect(first).toMatchObject({ code: 0, out: 'ci/ledger/260920-083000-shard-lint.md\n' });
    expect(second.out).toBe('ci/ledger/260920-083001-cache-turbo.md\n');
    // The scaffold is deliberately invalid until its placeholders are filled.
    const check = run(['ledger-check'], root);
    expect(check.code).toBe(1);
    expect(check.err).toContain('260920-083000-shard-lint.md');
    expect(run(['ledger-new', '--slug', 'Bad Slug'], root).code).toBe(2);
  });

  it('coverage reads the real git diff against --base', () => {
    const root = fixture();
    git(root, 'init', '-q', '-b', 'main');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    const wf = path.join(root, '.github/workflows/lint.yml');
    writeFileSync(
      wf,
      readFileSync(wf, 'utf8').replace('timeout-minutes: 15', 'timeout-minutes: 20')
    );
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'raise timeout');

    const cov = ['ledger-check', '--coverage', '--base', base, '--branch', 'feat/x'];
    // The fixture config switches coverage to blocking on 2026-09-27.
    const warned = run([...cov, '--now', '2026-09-26T23:59:59Z'], root);
    expect(warned.code).toBe(0);
    expect(warned.out).toContain('warning only until 2026-09-27');
    expect(warned.out).toContain(
      '::warning file=ci/ledger,title=ci-steward coverage/missing-entry::'
    );
    const miss = run([...cov, '--now', '2026-09-27T00:00:00Z'], root);
    expect(miss.code).toBe(1);
    expect(miss.err).toContain('coverage/missing-entry');
    expect(miss.err).toContain('.github/workflows/lint.yml');

    writeFileSync(
      path.join(root, 'ci/ledger/260920-090000-raise-lint-timeout.md'),
      ledgerEntry('260920-090000')
    );
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ledger');
    expect(
      run(['ledger-check', '--coverage', '--base', base, '--branch', 'feat/x'], root)
    ).toMatchObject({ code: 0 });
    expect(run(['ledger-check'], root).code).toBe(0);
  });

  it('runs under the real node binary with no build step', () => {
    const root = fixture();
    const ok = spawnSync(process.execPath, [CLI, 'census', '--root', root], { encoding: 'utf8' });
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('ci-steward census: ok\n');
  });
});
