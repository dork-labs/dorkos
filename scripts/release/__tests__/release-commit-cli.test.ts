/**
 * The release-commit CLI: what it writes to `--out`, that it writes the same
 * bytes every time, and the arguments it refuses (`--commit` above all, which
 * stays unwired until go-live).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMIT_NOT_WIRED, main } from '../release-commit.ts';
import { fixtureRepo, FIXTURE_DATE, FIXTURE_PREVIOUS, type FixtureRepo } from './fixture-repo.ts';

const SCRIPT = fileURLToPath(new URL('../release-commit.ts', import.meta.url));

let repo: FixtureRepo;
let scratch: string;
let errors: string[];
beforeEach(() => {
  repo = fixtureRepo();
  scratch = mkdtempSync(path.join(tmpdir(), 'release-commit-out-'));
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  repo.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

function args(out: string, ...extra: string[]): string[] {
  return [
    '--repo',
    repo.dir,
    '--previous',
    FIXTURE_PREVIOUS,
    '--date',
    FIXTURE_DATE,
    '--out',
    out,
    ...extra,
  ];
}

/** Every file under `dir`, relative path to contents. */
function tree(dir: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, tree(dir, relative));
    else files[relative] = readFileSync(path.join(dir, relative), 'utf8');
  }
  return files;
}

describe('release-commit --dry-run', () => {
  it('writes the changed files under tree/, plus plan.json, notes.md and pr-body.md', () => {
    const out = path.join(scratch, 'out');
    expect(main(args(out, '--dry-run'))).toBe(0);
    const files = Object.keys(tree(out)).sort();
    expect(files).toContain('plan.json');
    expect(files).toContain('notes.md');
    expect(files).toContain('pr-body.md');
    expect(files).toContain('tree/VERSION');
    expect(files).toContain('tree/changelog/archive/CHANGELOG-v0.1.0-to-v0.14.0.md');
    expect(files.some((file) => file.startsWith('tree/changelog/unreleased/'))).toBe(false);
    const plan = JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8'));
    expect(plan).toMatchObject({
      version: '0.20.1',
      previous: '0.20.0',
      bump: 'patch',
      breaking: false,
    });
    expect(plan.files).toContainEqual({
      path: 'changelog/archive/CHANGELOG-v0.1.0-to-v0.13.0.md',
      status: 'D',
    });
    // The release point itself is never written to.
    expect(repo.read('VERSION')).toBe('0.20.0');
  });

  it('writes identical bytes on every run', () => {
    writeFileSync(path.join(scratch, 'commits'), 'bbbbbbb2222 feat(x): unwritten (#11)\n');
    const commits = ['--commits', path.join(scratch, 'commits')];
    expect(main(args(path.join(scratch, 'one'), ...commits))).toBe(0);
    expect(main(args(path.join(scratch, 'two'), ...commits))).toBe(0);
    const one = tree(path.join(scratch, 'one'));
    expect(Object.keys(one).length).toBeGreaterThan(10);
    expect(tree(path.join(scratch, 'two'))).toEqual(one);
  });

  it('runs as a program under plain node and prints the plan as JSON', () => {
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--repo',
        repo.dir,
        '--previous',
        FIXTURE_PREVIOUS,
        '--date',
        FIXTURE_DATE,
        '--json',
      ],
      { encoding: 'utf8' }
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: '0.20.1',
      subject: 'chore(release): v0.20.1',
    });
  });
});

describe('release-commit refusals', () => {
  it('refuses --commit, which is not wired until go-live', () => {
    expect(main([...args(path.join(scratch, 'out')), '--commit'])).toBe(2);
    expect(errors).toEqual([COMMIT_NOT_WIRED]);
  });

  it('needs --repo, --previous and --date, and never defaults the date from the clock', () => {
    expect(main(['--repo', repo.dir, '--previous', FIXTURE_PREVIOUS])).toBe(2);
    expect(errors[0]).toMatch(/--date are all required/);
  });

  it('refuses an unknown flag', () => {
    expect(main([...args(path.join(scratch, 'out')), '--force'])).toBe(2);
  });

  it('exits 1 when there is nothing to release', () => {
    for (const name of readdirSync(path.join(repo.dir, 'changelog/unreleased')))
      if (name.endsWith('.md')) repo.remove(`changelog/unreleased/${name}`);
    expect(main(args(path.join(scratch, 'out')))).toBe(1);
    expect(errors[0]).toMatch(/Nothing to release/);
  });

  it('refuses an --out that is not empty, or inside the release point', () => {
    const full = path.join(scratch, 'full');
    mkdirSync(full);
    writeFileSync(path.join(full, 'stale'), 'x');
    expect(main(args(full))).toBe(1);
    expect(errors[0]).toMatch(/is not empty/);
    expect(main(args(path.join(repo.dir, 'out')))).toBe(1);
    expect(errors[1]).toMatch(/outside the release point/);
  });
});
