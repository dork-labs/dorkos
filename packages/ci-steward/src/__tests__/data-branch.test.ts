/**
 * The data-branch safeguards, proven against temporary bare repositories.
 * Nothing here touches a real remote: every "origin" is a directory in tmp.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DataBranchMissing,
  prepareDataDir,
  publish,
  realGit,
  remoteState,
  removeDataDir,
  tagWeek,
  type DataBranchRef,
} from '../data-branch.ts';
import { gitReader, renderStatus } from '../status.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...ID, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A bare "origin" with a main branch, and a clone of it standing in for the Actions checkout. */
function world() {
  const base = mkdtempSync(path.join(tmpdir(), 'ci-steward-db-'));
  dirs.push(base);
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(base, 'seed');
  git(base, 'clone', '-q', origin, seed);
  writeFileSync(path.join(seed, 'app.ts'), 'export {};\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'main');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const clone = path.join(base, 'clone');
  git(base, 'clone', '-q', origin, clone);
  const ref: DataBranchRef = {
    repo: clone,
    remote: 'origin',
    branch: 'ci-steward-data',
    tagPrefix: 'ci-steward-data/',
  };
  return { base, origin, clone, ref, dir: (n: string) => path.join(base, n) };
}

describe('the data branch', () => {
  it('is created on the very first run only, as an orphan holding no repo code', () => {
    const w = world();
    const dir = w.dir('data');
    expect(prepareDataDir(realGit, w.ref, dir)).toEqual({ bootstrapped: true });
    expect(existsSync(path.join(dir, 'app.ts'))).toBe(false);
    writeFileSync(path.join(dir, 'latest.json'), '{}\n');
    const sha = publish(realGit, w.ref, dir, 'first');
    expect(remoteState(realGit, w.ref).head).toBe(sha);
    // An orphan: no parent, and only data files in its tree.
    expect(git(w.origin, 'rev-list', '--count', 'ci-steward-data')).toBe('1');
    expect(git(w.origin, 'ls-tree', '--name-only', 'ci-steward-data').split('\n').sort()).toEqual([
      'README.md',
      'latest.json',
    ]);
    removeDataDir(realGit, w.ref, dir);
    // The second run checks the existing branch out instead of creating one.
    expect(prepareDataDir(realGit, w.ref, w.dir('data2'))).toEqual({ bootstrapped: false });
    expect(readFileSync(path.join(w.dir('data2'), 'latest.json'), 'utf8')).toBe('{}\n');
  });

  it('refuses to recreate a missing branch when a backup tag exists, and names the restore command', () => {
    const w = world();
    const dir = w.dir('data');
    prepareDataDir(realGit, w.ref, dir);
    writeFileSync(path.join(dir, 'latest.json'), '{"v":1}\n');
    publish(realGit, w.ref, dir, 'first');
    expect(tagWeek(realGit, w.ref, dir, '2026-W38')).toEqual({
      tag: 'ci-steward-data/2026-W38',
      created: true,
    });
    removeDataDir(realGit, w.ref, dir);
    // The branch is lost (a ruleset would stop this on GitHub; a bare repo lets us plant it).
    git(w.origin, 'update-ref', '-d', 'refs/heads/ci-steward-data');
    let caught: unknown;
    try {
      prepareDataDir(realGit, w.ref, w.dir('again'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DataBranchMissing);
    const cmd = (caught as DataBranchMissing).restoreCommand;
    expect(cmd).toBe(
      "git fetch origin tag ci-steward-data/2026-W38 && git push origin 'ci-steward-data/2026-W38^{commit}:refs/heads/ci-steward-data'"
    );
    expect(remoteState(realGit, w.ref).head).toBeNull();
    // The restore command, run as printed, brings the history back.
    execFileSync('sh', ['-c', cmd], { cwd: w.clone, stdio: 'ignore' });
    expect(git(w.origin, 'show', 'ci-steward-data:latest.json')).toBe('{"v":1}');
  });

  it('fetches, rebases and retries when another writer pushed first', () => {
    const w = world();
    const a = w.dir('a');
    prepareDataDir(realGit, w.ref, a);
    writeFileSync(path.join(a, 'latest.json'), '{}\n');
    publish(realGit, w.ref, a, 'collector');
    // A second writer (a clone's local export) checks out and holds its commit.
    const b = w.dir('b');
    prepareDataDir(realGit, w.ref, b);
    // The collector pushes again meanwhile.
    writeFileSync(path.join(a, 'snapshot.json'), '{}\n');
    publish(realGit, w.ref, a, 'collector again');
    // The second writer's push is rejected, then rebased and retried.
    execFileSync('mkdir', ['-p', path.join(b, 'local', 'clone-x')]);
    writeFileSync(path.join(b, 'local', 'clone-x', '2026-09-18.json'), '{}\n');
    publish(realGit, w.ref, b, 'local export', { backoffMs: 1 });
    expect(
      git(w.origin, 'ls-tree', '-r', '--name-only', 'ci-steward-data').split('\n').sort()
    ).toEqual(['README.md', 'latest.json', 'local/clone-x/2026-09-18.json', 'snapshot.json']);
    expect(git(w.origin, 'rev-list', '--count', 'ci-steward-data')).toBe('3');
  });

  it('publishes nothing when nothing changed, and tags a week once', () => {
    const w = world();
    const dir = w.dir('data');
    prepareDataDir(realGit, w.ref, dir);
    publish(realGit, w.ref, dir, 'first');
    expect(publish(realGit, w.ref, dir, 'again')).toBe('nothing');
    expect(tagWeek(realGit, w.ref, dir, '2026-W39').created).toBe(true);
    expect(tagWeek(realGit, w.ref, dir, '2026-W39').created).toBe(false);
    expect(remoteState(realGit, w.ref).tags).toEqual(['ci-steward-data/2026-W39']);
  });

  it('status says plainly when the branch does not exist, and reads it through git when it does', () => {
    const w = world();
    const none = renderStatus(
      gitReader(w.clone, 'origin/ci-steward-data'),
      [],
      new Date('2026-09-19T06:00:00Z')
    );
    expect(none).toContain('the ci-steward-data branch does not exist yet');
    const dir = w.dir('data');
    prepareDataDir(realGit, w.ref, dir);
    publish(realGit, w.ref, dir, 'first');
    git(
      w.clone,
      'fetch',
      '-q',
      'origin',
      '+refs/heads/ci-steward-data:refs/remotes/origin/ci-steward-data'
    );
    const some = renderStatus(
      gitReader(w.clone, 'origin/ci-steward-data'),
      [],
      new Date('2026-09-19T06:00:00Z')
    );
    expect(some).toContain('origin/ci-steward-data has no latest.json yet');
  });
});
