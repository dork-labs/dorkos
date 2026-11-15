/**
 * The pre-push mid-run guard (`scripts/pre-push-midrun-check.mjs`).
 *
 * A push to a branch with an open PR cancels the `test` and `browser-test`
 * runs still going on its previous head (both workflows set
 * `cancel-in-progress` on `pull_request`). Over Nov 12 00Z to Nov 15 16Z that
 * threw away 74 job-hours. The guard refuses a push while one of those runs is
 * under ten minutes old, and gets out of the way in every other case: an old
 * run, a finished run, `CI_PUSH_ANYWAY=1`, or any failure to ask GitHub.
 *
 * Every case runs the real script against a throwaway git repository with a
 * fake `gh` first on PATH. Nothing here talks to GitHub. PATH holds only a
 * directory with `git` linked into it (and the fake `gh` when a case wants
 * one), so "gh is not installed" is true even on a runner that ships it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'pre-push-midrun-check.mjs');

/** The real git binary, found on the PATH vitest was started with. */
function realGit(): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'git');
    if (dir && existsSync(candidate)) return candidate;
  }
  throw new Error('no git on PATH');
}

let work: string;
let bin: string;
let repo: string;

/** Runs git in the fixture repository and fails the test if git does. */
function git(...args: string[]): string {
  const r = spawnSync(realGit(), args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Minutes ago, as the ISO timestamp `gh run list --json createdAt` gives. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * Installs a fake `gh` that answers `run list` for each workflow file with the
 * JSON given for it (`[]` for a workflow not named), and records its argv.
 */
function fakeGh(runs: Record<string, unknown[]>, opts: { body?: string } = {}) {
  const lines = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${path.join(work, 'gh-calls')}"`,
    ...(opts.body !== undefined
      ? [opts.body]
      : [
          'wf=""',
          'prev=""',
          'for a in "$@"; do',
          '  [ "$prev" = "--workflow" ] && wf="$a"',
          '  prev="$a"',
          'done',
          ...Object.entries(runs).map(
            ([wf, list]) =>
              `[ "$wf" = "${wf}" ] && { printf '%s\\n' '${JSON.stringify(list)}'; exit 0; }`
          ),
          "printf '[]\\n'",
        ]),
  ];
  const file = path.join(bin, 'gh');
  writeFileSync(file, lines.join('\n') + '\n');
  chmodSync(file, 0o755);
}

/** Runs the guard in the fixture repo with a PATH of only the fake bin dir. */
function runCheck(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: bin, HOME: work, ...env },
  });
}

beforeEach(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'midrun-'));
  bin = path.join(work, 'bin');
  repo = path.join(work, 'repo');
  spawnSync(realGit(), ['init', '-q', '-b', 'feature/x', repo]);
  // `mkdir -p` by hand: the symlink needs its directory.
  spawnSync('mkdir', ['-p', bin]);
  symlinkSync(realGit(), path.join(bin, 'git'));
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('commit', '-q', '--allow-empty', '-m', 'one');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('a run still going from the last push', () => {
  it('refuses the push when test.yml started under ten minutes ago', () => {
    fakeGh({ 'test.yml': [{ status: 'in_progress', createdAt: ago(3), databaseId: 101 }] });
    const r = runCheck();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/test/);
    expect(r.stdout + r.stderr).toMatch(/3 min/);
    expect(r.stdout + r.stderr).toMatch(/cancel/i);
    expect(r.stdout + r.stderr).toContain('CI_PUSH_ANYWAY=1');
  });

  it('refuses for a queued browser-test run too, and asks about this branch', () => {
    fakeGh({ 'browser-test.yml': [{ status: 'queued', createdAt: ago(1), databaseId: 7 }] });
    const r = runCheck();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/browser-test/);
    const calls = spawnSync('cat', [path.join(work, 'gh-calls')], { encoding: 'utf8' }).stdout;
    expect(calls).toMatch(/--branch feature\/x/);
  });

  it('lets the push through when the run is over ten minutes old', () => {
    fakeGh({ 'test.yml': [{ status: 'in_progress', createdAt: ago(12), databaseId: 1 }] });
    expect(runCheck().status).toBe(0);
  });

  it('lets the push through when the last run has finished', () => {
    fakeGh({ 'test.yml': [{ status: 'completed', createdAt: ago(2), databaseId: 1 }] });
    expect(runCheck().status).toBe(0);
  });

  it('lets the push through with CI_PUSH_ANYWAY=1, and never asks GitHub', () => {
    fakeGh({ 'test.yml': [{ status: 'in_progress', createdAt: ago(2), databaseId: 1 }] });
    const r = runCheck({ CI_PUSH_ANYWAY: '1' });
    expect(r.status).toBe(0);
    expect(existsSync(path.join(work, 'gh-calls'))).toBe(false);
  });
});

describe('anything that goes wrong lets the push through with one warning', () => {
  it('gh is not installed', () => {
    const r = runCheck();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/pre-push midrun/);
  });

  it('gh fails (no auth, no network)', () => {
    fakeGh({}, { body: "echo 'gh: To get started, run gh auth login' >&2; exit 4" });
    const r = runCheck();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/pre-push midrun/);
  });

  it('gh prints something that is not JSON', () => {
    fakeGh({}, { body: "echo 'not json'" });
    const r = runCheck();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/pre-push midrun/);
  });

  it('gh hangs: the call is cut off and the push goes through', () => {
    fakeGh({}, { body: 'sleep 30' });
    const started = Date.now();
    const r = runCheck({ CI_MIDRUN_TIMEOUT_MS: '500' });
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.stdout + r.stderr).toMatch(/pre-push midrun/);
  });

  it('a detached HEAD has no branch to ask about', () => {
    fakeGh({ 'test.yml': [{ status: 'in_progress', createdAt: ago(2), databaseId: 1 }] });
    git('checkout', '-q', '--detach');
    expect(runCheck().status).toBe(0);
  });
});

describe('pushes that cannot cancel anything are not asked about', () => {
  it('main is skipped', () => {
    fakeGh({ 'test.yml': [{ status: 'in_progress', createdAt: ago(2), databaseId: 1 }] });
    git('checkout', '-q', '-b', 'main');
    expect(runCheck().status).toBe(0);
    expect(existsSync(path.join(work, 'gh-calls'))).toBe(false);
  });

  it('a branch already at its pushed tip (a delete-only push) is skipped', () => {
    fakeGh({ 'test.yml': [{ status: 'in_progress', createdAt: ago(2), databaseId: 1 }] });
    git('update-ref', 'refs/remotes/origin/feature/x', 'HEAD');
    expect(runCheck().status).toBe(0);
    expect(existsSync(path.join(work, 'gh-calls'))).toBe(false);
  });
});
