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
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  realpath,
  stat,
  utimes,
  chmod,
  symlink,
} from 'node:fs/promises';
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
    // A root nobody has created yet is the ordinary empty state, not a fault —
    // so it reports no warning, unlike a root that exists but will not open.
    await expect(scanWorktrees(missing)).resolves.toEqual({
      root: missing,
      worktrees: [],
      warnings: [],
    });
  });

  it('reports no warnings when every directory opened', async () => {
    await expect(scanWorktrees(fx.root)).resolves.toMatchObject({ warnings: [] });
  });
});

describe('scanWorktrees degradation', () => {
  let base: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'ws-degrade-')));
  }, 60_000);

  afterAll(async () => {
    // Restore the mode first, or the recursive remove cannot descend into it.
    await chmod(path.join(base, 'locked', 'workspaces', 'sealed'), 0o755).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });

  it('reports a real deleted upstream instead of calling it in sync', async () => {
    const home = path.join(base, 'gone');
    const root = path.join(home, 'workspaces');
    const source = path.join(home, 'source');
    const origin = path.join(home, 'origin.git');
    await mkdir(path.join(root, 'core'), { recursive: true });

    git(['init', '--bare', '-b', 'main', origin], home);
    await mkdir(source, { recursive: true });
    git(['clone', origin, source], home);
    git(['config', 'user.email', 't@example.com'], source);
    git(['config', 'user.name', 'Test'], source);
    await writeFile(path.join(source, 'README.md'), '# s\n');
    git(['add', '.'], source);
    git(['commit', '-m', 'init'], source);
    git(['push', '-u', 'origin', 'main'], source);

    // Branch, push it so it has a real upstream, then delete the remote branch —
    // exactly what happens when a pull request merges and GitHub tidies up.
    const merged = path.join(root, 'core', 'merged');
    git(['worktree', 'add', merged, '-b', 'feat/merged'], source);
    git(['push', '-u', 'origin', 'feat/merged'], merged);
    git(['push', 'origin', '--delete', 'feat/merged'], merged);

    const { worktrees } = await scanWorktrees(root);
    const row = worktrees.find((w) => w.name === 'merged');

    expect(row?.upstreamGone).toBe(true);
    // The lie this guards: reading `[gone]` as a tracking branch reports 0/0,
    // which the page renders as "In sync" with a branch that is not there.
    expect(row?.ahead).toBeNull();
    expect(row?.behind).toBeNull();
    expect(row?.branch).toBe('feat/merged');
  });

  it('warns instead of silently dropping the checkouts in an unreadable folder', async () => {
    const home = path.join(base, 'locked');
    const root = path.join(home, 'workspaces');
    const source = path.join(home, 'source');
    const sealed = path.join(root, 'sealed');
    await mkdir(sealed, { recursive: true });
    await mkdir(source, { recursive: true });

    git(['init', '-b', 'main', '.'], source);
    git(['config', 'user.email', 't@example.com'], source);
    git(['config', 'user.name', 'Test'], source);
    await writeFile(path.join(source, 'README.md'), '# s\n');
    git(['add', '.'], source);
    git(['commit', '-m', 'init'], source);
    git(['worktree', 'add', path.join(sealed, 'hidden'), '-b', 'wt/hidden'], source);

    await chmod(sealed, 0o000);

    const result = await scanWorktrees(root);

    // Returning `[]` for a folder that could not be OPENED is how a real
    // project directory once dropped 7 checkouts with nothing to show for it.
    expect(result.worktrees).toHaveLength(0);
    expect(result.warnings).toEqual([{ path: sealed, reason: 'EACCES' }]);
  });

  it('adopts a symlinked checkout directory instead of skipping it', async () => {
    // The layout some `gtr` setups and manual `ln -s` adoption produce: the
    // real checkout lives elsewhere, and the project folder only holds a
    // symlink to it. `entry.isDirectory()` is false for a symlink no matter
    // what it points at, so without a fallback this checkout is invisible.
    const home = path.join(base, 'symlinked');
    const root = path.join(home, 'workspaces');
    const project = path.join(root, 'core');
    const source = path.join(home, 'source');
    const realCheckout = path.join(home, 'real-checkout');
    await mkdir(project, { recursive: true });
    await mkdir(source, { recursive: true });

    git(['init', '-b', 'main', '.'], source);
    git(['config', 'user.email', 't@example.com'], source);
    git(['config', 'user.name', 'Test'], source);
    await writeFile(path.join(source, 'README.md'), '# s\n');
    git(['add', '.'], source);
    git(['commit', '-m', 'init'], source);
    git(['worktree', 'add', realCheckout, '-b', 'feat/linked'], source);

    await symlink(realCheckout, path.join(project, 'linked'), 'dir');

    const { worktrees, warnings } = await scanWorktrees(root);
    const linked = worktrees.find((w) => w.name === 'linked');

    expect(linked).toBeDefined();
    expect(linked?.readable).toBe(true);
    expect(linked?.branch).toBe('feat/linked');
    expect(warnings).toEqual([]);
  });

  it('warns on dangling symlinks, sorted by name, instead of silently dropping them', async () => {
    // A symlink whose target has been moved or deleted. `fs.stat` on it fails,
    // so the scan cannot know whether it was ever a directory — the same
    // "hides whatever it held" problem an unopenable folder poses, and it
    // gets the same answer: report it, don't drop it.
    //
    // `Zebra`/`ant` is not a cosmetic choice: on this machine's filesystem,
    // `readdir` already returns entries in raw byte order (`Zebra` before
    // `ant`, capital letters sort first), which happens to equal the sorted
    // order for names that differ only in case-insensitive letter position.
    // Pairing a leading capital with a leading lowercase makes byte order and
    // `localeCompare` order disagree — `readdir` still yields `Zebra` before
    // `ant`, but `localeCompare` puts `ant` first — so this assertion can only
    // pass if the code actually sorts by name.
    const home = path.join(base, 'dangling');
    const root = path.join(home, 'workspaces');
    const project = path.join(root, 'core');
    await mkdir(project, { recursive: true });

    const zebraLink = path.join(project, 'Zebra');
    const antLink = path.join(project, 'ant');
    await symlink(path.join(home, 'does-not-exist'), zebraLink, 'dir');
    await symlink(path.join(home, 'also-does-not-exist'), antLink, 'dir');

    const result = await scanWorktrees(root);

    expect(result.worktrees).toHaveLength(0);
    expect(result.warnings).toEqual([
      { path: antLink, reason: 'ENOENT' },
      { path: zebraLink, reason: 'ENOENT' },
    ]);
  });

  it('adopts a symlinked PROJECT folder, not just a symlinked checkout', async () => {
    // The scan walks two levels — root/project/checkout — and a symlink can
    // stand in at either one. This pins the level the other adoption test
    // does not: `root/core` itself is a symlink to a real project directory
    // living elsewhere.
    const home = path.join(base, 'symlinked-project');
    const root = path.join(home, 'workspaces');
    const realProject = path.join(home, 'real-project');
    const source = path.join(home, 'source');
    await mkdir(root, { recursive: true });
    await mkdir(realProject, { recursive: true });
    await mkdir(source, { recursive: true });

    git(['init', '-b', 'main', '.'], source);
    git(['config', 'user.email', 't@example.com'], source);
    git(['config', 'user.name', 'Test'], source);
    await writeFile(path.join(source, 'README.md'), '# s\n');
    git(['add', '.'], source);
    git(['commit', '-m', 'init'], source);
    git(['worktree', 'add', path.join(realProject, 'checkout'), '-b', 'feat/proj-linked'], source);

    await symlink(realProject, path.join(root, 'core'), 'dir');

    const { worktrees, warnings } = await scanWorktrees(root);
    const checkout = worktrees.find((w) => w.name === 'checkout');

    expect(checkout).toBeDefined();
    expect(checkout?.project).toBe('core');
    expect(checkout?.readable).toBe(true);
    expect(warnings).toEqual([]);
  });
});

/**
 * Ordering gets its own root. The shared fixture above commits everything in
 * the same second and in one project, so its rows could be shuffled without a
 * single assertion noticing. These commits are minutes apart, in two projects,
 * and one pair is deliberately written in different time zones.
 */
describe('scanWorktrees ordering', () => {
  let base: string;
  let root: string;

  /** Commit with an exact committer date — `%cI`, the field the scan sorts on. */
  function commitAt(cwd: string, message: string, iso: string): void {
    execFileSync('git', ['commit', '--allow-empty', '-m', message, '--date', iso], {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, GIT_COMMITTER_DATE: iso },
    });
  }

  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'ws-order-')));
    root = path.join(base, 'workspaces');
    const source = path.join(base, 'source');
    await mkdir(source, { recursive: true });
    await mkdir(path.join(root, 'alpha'), { recursive: true });
    await mkdir(path.join(root, 'beta'), { recursive: true });

    git(['init', '-b', 'main', '.'], source);
    git(['config', 'user.email', 't@example.com'], source);
    git(['config', 'user.name', 'Test'], source);
    commitAt(source, 'root', '2026-01-01T00:00:00+00:00');

    // `oldest` and `newest` are hours apart, so any comparator gets them right.
    // `zoned-*` is the real test: written as text, `2026-06-02T01:00:00+05:00`
    // sorts ABOVE `2026-06-01T23:00:00+00:00`, but as instants it is three
    // hours EARLIER (20:00Z vs 23:00Z). A string compare gets this pair
    // backwards, which is why the comparator parses both sides.
    const trees: Array<[string, string, string]> = [
      ['alpha', 'oldest', '2026-06-01T09:00:00+00:00'],
      ['alpha', 'zoned-earlier', '2026-06-02T01:00:00+05:00'],
      ['alpha', 'zoned-later', '2026-06-01T23:00:00+00:00'],
      ['alpha', 'newest', '2026-06-03T09:00:00+00:00'],
      ['beta', 'only', '2026-06-04T09:00:00+00:00'],
    ];
    for (const [project, name, iso] of trees) {
      const dir = path.join(root, project, name);
      git(['worktree', 'add', dir, '-b', `wt/${name}`], source);
      commitAt(dir, name, iso);
    }

    // No commits at all, so no date to sort by. It must sort last within its
    // project rather than floating to the top.
    const undated = path.join(root, 'alpha', 'undated');
    git(['worktree', 'add', '--detach', undated], source);
  }, 60_000);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('sorts by project, then newest commit first, dateless last', async () => {
    const { worktrees } = await scanWorktrees(root);

    expect(worktrees.map((w) => `${w.project}/${w.name}`)).toEqual([
      'alpha/newest',
      'alpha/zoned-later',
      'alpha/zoned-earlier',
      'alpha/oldest',
      // `undated` sits on the root commit, the oldest date in the fixture, so
      // it lands last in alpha either way — asserted by position, not by luck.
      'alpha/undated',
      'beta/only',
    ]);
  });
});

describe('parseStatusSummary', () => {
  it('reads a branch with an upstream and a divergence', () => {
    expect(parseStatusSummary('## main...origin/main [ahead 3, behind 2]\n M a\n?? b\n')).toEqual({
      branch: 'main',
      ahead: 3,
      behind: 2,
      upstreamGone: false,
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
      upstreamGone: false,
      changedFiles: 0,
    });
  });

  it('never reports a deleted upstream as zero divergence', () => {
    // git's wording once a merged PR's remote branch is deleted. It looks like
    // a tracking branch, so reading it as one yields `0 ahead, 0 behind` and the
    // page says "In sync" about a remote that no longer exists. 19 of the 27
    // real checkouts on the machine this was built for print exactly this.
    expect(parseStatusSummary('## feat/x...origin/feat/x [gone]\n')).toEqual({
      branch: 'feat/x',
      ahead: null,
      behind: null,
      upstreamGone: true,
      changedFiles: 0,
    });
  });

  it('reads a detached HEAD as no branch', () => {
    expect(parseStatusSummary('## HEAD (no branch)\n M a\n')).toEqual({
      branch: null,
      ahead: null,
      behind: null,
      upstreamGone: false,
      changedFiles: 1,
    });
  });

  it('pulls the branch name out of an unborn checkout', () => {
    // Without this the whole sentence lands in the branch column, rendered
    // beside a branch icon as though "No commits yet on main" were a ref.
    expect(parseStatusSummary('## No commits yet on main\n?? a\n')).toEqual({
      branch: 'main',
      ahead: null,
      behind: null,
      upstreamGone: false,
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
