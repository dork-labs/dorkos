/**
 * The read-only adoption scan (DOR-1056), exercised against REAL temp git
 * repositories — the whole point of the feature is what git actually reports
 * about checkouts on disk, which a mocked `execFile` could not tell us.
 *
 * The scan's two safety properties get their own tests, because both are the
 * kind that fail silently: it must not write to a checkout another agent is
 * working in, and one broken checkout must not take the page down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, realpath, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanWorktrees, parseStatusSummary, repoPathFromCommonDir } from '../worktree-scan.js';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** One scanned root shared by the whole suite — building it spends ~20 git calls. */
interface Fixture {
  base: string;
  root: string;
  source: string;
  clean: string;
  dirty: string;
  diverged: string;
  detached: string;
  broken: string;
}

let fx: Fixture;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'ws-scan-')));
  const root = path.join(base, 'workspaces');
  const project = path.join(root, 'core');
  const source = path.join(base, 'source');
  const origin = path.join(base, 'origin.git');

  git(['init', '--bare', '-b', 'main', origin], base);
  await mkdir(source, { recursive: true });
  git(['clone', origin, source], base);
  git(['config', 'user.email', 't@example.com'], source);
  git(['config', 'user.name', 'Test'], source);
  await writeFile(path.join(source, 'README.md'), '# source\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'init'], source);
  git(['push', '-u', 'origin', 'main'], source);

  await mkdir(project, { recursive: true });

  const clean = path.join(project, 'clean-tree');
  git(['worktree', 'add', clean, '-b', 'feat/clean'], source);

  const dirty = path.join(project, 'dirty-tree');
  git(['worktree', 'add', dirty, '-b', 'feat/dirty'], source);
  await writeFile(path.join(dirty, 'README.md'), '# edited\n');
  await writeFile(path.join(dirty, 'scratch.txt'), 'untracked\n');

  // Ahead AND behind: commit locally, then advance the upstream from `source`.
  // Both checkouts share one object store, so the push moves `origin/main` for
  // the worktree too — no fetch needed, which is why the scan never runs one.
  const diverged = path.join(project, 'diverged-tree');
  git(['worktree', 'add', diverged, '-b', 'feat/diverged'], source);
  git(['branch', '--set-upstream-to=origin/main', 'feat/diverged'], diverged);
  await writeFile(path.join(diverged, 'local.txt'), 'local\n');
  git(['add', '.'], diverged);
  git(['commit', '-m', 'local work'], diverged);
  await writeFile(path.join(source, 'upstream.txt'), 'upstream\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'upstream work'], source);
  git(['push', 'origin', 'main'], source);

  const detached = path.join(project, 'detached-tree');
  git(['worktree', 'add', '--detach', detached], source);

  // A checkout whose `.git` pointer names a repository that is not there — the
  // shape left behind when someone moves or deletes the source repo.
  const broken = path.join(project, 'broken-tree');
  await mkdir(broken, { recursive: true });
  await writeFile(path.join(broken, '.git'), `gitdir: ${path.join(base, 'gone', '.git')}\n`);

  // A plain folder that is not a checkout at all. The real root has one of
  // these; it must not appear as a worktree.
  await mkdir(path.join(project, '_scratch'), { recursive: true });

  fx = { base, root, source, clean, dirty, diverged, detached, broken };
}, 60_000);

afterAll(async () => {
  await rm(fx.base, { recursive: true, force: true });
});

describe('scanWorktrees', () => {
  it('reports the real checkouts under the root, and nothing else', async () => {
    const result = await scanWorktrees(fx.root);

    expect(result.root).toBe(fx.root);
    expect(result.worktrees.map((w) => w.name).sort()).toEqual([
      'broken-tree',
      'clean-tree',
      'detached-tree',
      'dirty-tree',
      'diverged-tree',
    ]);
    // The folder with no `.git` is not a checkout and never becomes a row.
    expect(result.worktrees.some((w) => w.name === '_scratch')).toBe(false);
    // Every row is stamped with the project folder it was found in.
    expect(result.worktrees.every((w) => w.project === 'core')).toBe(true);
  });

  it('reports branch, repo, and last commit for a clean checkout', async () => {
    const { worktrees } = await scanWorktrees(fx.root);
    const clean = worktrees.find((w) => w.name === 'clean-tree');

    expect(clean).toMatchObject({
      path: fx.clean,
      branch: 'feat/clean',
      repoPath: fx.source,
      changedFiles: 0,
      readable: true,
    });
    expect(clean?.lastCommitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('counts uncommitted and untracked files together as changes', async () => {
    const { worktrees } = await scanWorktrees(fx.root);
    const dirty = worktrees.find((w) => w.name === 'dirty-tree');

    // One modified tracked file + one untracked file.
    expect(dirty?.changedFiles).toBe(2);
    expect(dirty?.branch).toBe('feat/dirty');
  });

  it('reports ahead and behind against the upstream branch', async () => {
    const { worktrees } = await scanWorktrees(fx.root);
    const diverged = worktrees.find((w) => w.name === 'diverged-tree');

    expect(diverged?.ahead).toBe(1);
    expect(diverged?.behind).toBe(1);
  });

  it('leaves ahead/behind unknown when a branch has no upstream', async () => {
    const { worktrees } = await scanWorktrees(fx.root);
    const clean = worktrees.find((w) => w.name === 'clean-tree');

    // `feat/clean` tracks nothing, so "ahead of what?" has no answer. Reporting
    // 0 would read as "in sync", which is a different and false claim.
    expect(clean?.ahead).toBeNull();
    expect(clean?.behind).toBeNull();
  });

  it('reads a detached HEAD as readable with no branch', async () => {
    const { worktrees } = await scanWorktrees(fx.root);
    const detached = worktrees.find((w) => w.name === 'detached-tree');

    expect(detached?.readable).toBe(true);
    expect(detached?.branch).toBeNull();
    expect(detached?.lastCommitAt).not.toBeNull();
  });

  it('keeps an unreadable checkout as a row instead of dropping or throwing', async () => {
    const { worktrees } = await scanWorktrees(fx.root);
    const broken = worktrees.find((w) => w.name === 'broken-tree');

    expect(broken).toBeDefined();
    expect(broken?.readable).toBe(false);
    expect(broken?.branch).toBeNull();
    expect(broken?.changedFiles).toBeNull();
    // The healthy checkouts beside it still resolved — one bad tree does not
    // poison the scan.
    expect(worktrees.filter((w) => w.readable)).toHaveLength(4);
  });

  it('does not write to the checkouts it reads', async () => {
    // Touching a tracked file makes the index stale, which is exactly when git
    // WANTS to rewrite it during `status`. `--no-optional-locks` is what stops
    // it. Without that flag this assertion fails: another agent's index would
    // be rewritten underneath them just because someone opened the page.
    const readme = path.join(fx.clean, 'README.md');
    const future = new Date(Date.now() + 5_000);
    await utimes(readme, future, future);

    const indexPath = path.join(fx.source, '.git', 'worktrees', 'clean-tree', 'index');
    const before = await stat(indexPath);
    await scanWorktrees(fx.root);
    const after = await stat(indexPath);

    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('returns an empty scan for a root that does not exist', async () => {
    const missing = path.join(fx.base, 'no-such-root');
    await expect(scanWorktrees(missing)).resolves.toEqual({ root: missing, worktrees: [] });
  });

  it('orders checkouts by project, then newest commit first', async () => {
    const { worktrees } = await scanWorktrees(fx.root);
    const dates = worktrees.map((w) => w.lastCommitAt);

    // Readable rows carry dates in non-increasing order; the unreadable one has
    // no date and sorts last rather than jumping to the top.
    const readableDates = dates.filter((d): d is string => d !== null);
    expect([...readableDates].sort().reverse()).toEqual(readableDates);
    expect(dates[dates.length - 1]).toBeNull();
  });
});

describe('parseStatusSummary', () => {
  it('reads a branch with an upstream and a divergence', () => {
    expect(parseStatusSummary('## main...origin/main [ahead 3, behind 2]\n M a\n?? b\n')).toEqual({
      branch: 'main',
      ahead: 3,
      behind: 2,
      changedFiles: 2,
    });
  });

  it('reads ahead-only and behind-only headers', () => {
    expect(parseStatusSummary('## f...origin/f [ahead 1]\n')).toMatchObject({
      ahead: 1,
      behind: 0,
    });
    expect(parseStatusSummary('## f...origin/f [behind 4]\n')).toMatchObject({
      ahead: 0,
      behind: 4,
    });
  });

  it('leaves ahead/behind null for a branch with no upstream', () => {
    expect(parseStatusSummary('## solo\n')).toEqual({
      branch: 'solo',
      ahead: null,
      behind: null,
      changedFiles: 0,
    });
  });

  it('reads a detached HEAD as no branch', () => {
    expect(parseStatusSummary('## HEAD (no branch)\n M a\n')).toEqual({
      branch: null,
      ahead: null,
      behind: null,
      changedFiles: 1,
    });
  });
});

describe('repoPathFromCommonDir', () => {
  it('names the repository a worktree shares history with', () => {
    expect(repoPathFromCommonDir('/repos/dorkos/.git\n')).toBe('/repos/dorkos');
  });

  it('passes through a bare repository path unchanged', () => {
    expect(repoPathFromCommonDir('/repos/dorkos.git\n')).toBe('/repos/dorkos.git');
  });

  it('reads empty output as unknown', () => {
    expect(repoPathFromCommonDir('')).toBeNull();
  });
});
