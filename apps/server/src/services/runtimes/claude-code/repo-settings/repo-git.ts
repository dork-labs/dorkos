/**
 * The few git reads the repo settings check needs (DOR-3298), each one an
 * `execFile` with an argument list (no shell), a timeout, and the hardening
 * every git command DorkOS runs itself carries (`internalGitArgs`: no hooks,
 * no file-system monitor, no implicit bare repository).
 *
 * Only plumbing that runs no repository-configured program is used here:
 * `rev-parse`, `symbolic-ref`, `ls-tree`, `cat-file`, `merge-base`,
 * `diff-tree` and `rev-list`. Nothing reads the working tree through git, so
 * a repository's own clean filter or diff driver is never started; working
 * files are read by the caller and hashed in-process ({@link gitBlobId}).
 *
 * **The repo is the agent's.** These reads run in a repo an agent can write,
 * config included, so every one goes through `runSafeGitBuffer`: today the
 * stand-in in `safe-git-interim.ts`, and DOR-3343's shared runner
 * (`@dorkos/shared/safe-git`) once it is on main, which also audits the
 * repo's settings key by key. Either way: no lazy fetch of a missing object (a
 * promisor remote's `core.sshCommand` would otherwise run as the server), no
 * transport at all, no ssh, credential or askpass helper, and none of the
 * server's own environment. A read that would need any of them fails, and a
 * failed read pauses the repo's settings.
 *
 * @module services/runtimes/claude-code/repo-settings/repo-git
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
// Switch to '@dorkos/shared/safe-git' once DOR-3343's runner (#3216) is on main.
import { gitRuns, runSafeGitBuffer } from './safe-git-interim.js';

/** How long one git read may take. */
const GIT_TIMEOUT_MS = 5_000;

/** The most output one git read may return. Settings files are capped at 64 KB. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Switches that keep a repo's own files from changing what a commit holds or
 * descends from. An agent can write all of them: replace refs
 * (`git replace <commit> <its own>`) swap a commit's tree under the same id,
 * and a crafted commit-graph file can claim parents a commit does not have.
 * `info/grafts` has no switch the runner lets a caller set, so a repo that
 * has one is refused ({@link locateRepo}). Forged pack or loose objects are
 * not caught here; that residual needs DorkOS's own copy of the default
 * branch (DOR-3339).
 */
const BASELINE_GIT_ARGS = ['--no-replace-objects', '-c', 'core.commitGraph=false'];

/** Whether git is installed, asked once per process. */
let gitInstalled: Promise<boolean> | undefined;

/** Thrown when git itself is not installed: the repo's committed settings then pause. */
export class GitMissingError extends Error {
  constructor() {
    super('git is not installed');
    this.name = 'GitMissingError';
  }
}

/**
 * Run one git command in `cwd` through the safe runner and return its stdout.
 * Every option goes in as an argument, never the environment: the runner
 * takes only the locale.
 *
 * @param cwd - The folder to run in.
 * @param args - The subcommand and its arguments, after any global options.
 * @throws {GitMissingError} When git is not installed.
 * @throws Any other git failure, as the runner reports it.
 */
async function git(cwd: string, args: string[]): Promise<Buffer> {
  try {
    return await runSafeGitBuffer([...BASELINE_GIT_ARGS, ...args], cwd, {
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { LC_ALL: 'C' },
    });
  } catch (err) {
    // A spawn reports a missing folder the same way as a missing program, so
    // ask git itself rather than guess.
    gitInstalled ??= gitRuns();
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !(await gitInstalled)) {
      throw new GitMissingError();
    }
    throw err;
  }
}

/** One git command's stdout as trimmed text, or `undefined` when it failed (git present). */
async function gitText(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(cwd, args)).toString('utf8').trim();
  } catch (err) {
    if (err instanceof GitMissingError) throw err;
    return undefined;
  }
}

/** Where a folder's repo is. */
export interface RepoLocation {
  /** The working tree's top folder (a worktree's own, not the main checkout's). */
  root: string;
  /** The repo's shared git folder, the same for every worktree of one repo. */
  commonDir: string;
}

/** The nearest folder at or above `dir` holding a `.git` entry, by real path. */
function workTreeTop(dir: string): string | null {
  let at: string;
  try {
    at = realpathSync.native(dir);
  } catch {
    return null;
  }
  for (;;) {
    if (existsSync(path.join(at, '.git'))) return at;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** Thrown when git places a folder's work tree somewhere the filesystem says it isn't. */
export class RepoLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoLocationError';
  }
}

/**
 * The repo a folder is in, or `null` when it is in none.
 *
 * The work tree's top is found on disk (the nearest `.git` entry), never taken
 * from git: a repo's own `core.worktree` moves where git says it is, which
 * would put the turn's folder outside the tree the check reads (DOR-3298 M1).
 * Git is then pinned to that top, and must agree the folder is inside it.
 *
 * @param cwd - The folder a turn launches in.
 * @throws {GitMissingError} When git is not installed.
 * @throws {RepoLocationError} When a `.git` is there but git disagrees.
 */
export async function locateRepo(cwd: string): Promise<RepoLocation | null> {
  const top = workTreeTop(cwd);
  if (!top) return null;
  // `--git-common-dir` may print a path relative to `cwd` on older git.
  const out = await gitText(cwd, [
    `--work-tree=${top}`,
    'rev-parse',
    '--is-inside-work-tree',
    '--show-toplevel',
    '--git-common-dir',
  ]);
  const [inside, root, commonDir] = (out ?? '').split('\n');
  if (inside !== 'true' || !root || !commonDir) {
    throw new RepoLocationError(`git could not place ${cwd} in the repo at ${top}`);
  }
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    realRoot = path.resolve(root);
  }
  if (realRoot !== top) {
    throw new RepoLocationError(`git puts the work tree of ${top} at ${root}`);
  }
  const shared = path.resolve(cwd, commonDir);
  if (existsSync(path.join(shared, 'info', 'grafts'))) {
    throw new RepoLocationError(`${shared} has a grafts file, which rewrites history`);
  }
  return { root: top, commonDir: shared };
}

/** The default branch's name and the commit it points at. */
export interface DefaultBranch {
  /** The ref that resolved, such as `origin/main` or `main`. */
  branch: string;
  /** Its commit id. */
  sha: string;
}

/**
 * The repo's default branch: what `origin/HEAD` names, else `origin/main`,
 * else a local `main` or `master`. `null` when none resolves.
 *
 * @param root - The repo's working tree top.
 * @throws {GitMissingError} When git is not installed.
 */
export async function resolveDefaultBranch(root: string): Promise<DefaultBranch | null> {
  const candidates: string[] = [];
  const head = await gitText(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head?.startsWith('refs/remotes/')) candidates.push(head.slice('refs/remotes/'.length));
  candidates.push('origin/main', 'main', 'master');
  for (const branch of candidates) {
    const sha = await gitText(root, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
    if (sha && /^[0-9a-f]{40,64}$/.test(sha)) return { branch, sha };
  }
  return null;
}

/**
 * The commit two commits last shared, or `null`.
 *
 * @param root - The repo's working tree top.
 * @param a - One commit or ref.
 * @param b - The other.
 */
export async function mergeBase(root: string, a: string, b: string): Promise<string | null> {
  const out = await gitText(root, ['merge-base', a, b]);
  return out && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
}

/**
 * Whether `ancestor` is in `descendant`'s history.
 *
 * @param root - The repo's working tree top.
 * @param ancestor - The older commit.
 * @param descendant - The newer one.
 */
export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (err) {
    if (err instanceof GitMissingError) throw err;
    return false;
  }
}

/**
 * The files at `paths` (files or folders, repo-relative, forward slashes) in a
 * commit, as path to blob id. Folders are listed recursively; a symlink or a
 * submodule is listed with its mode so the caller can refuse it.
 *
 * @param root - The repo's working tree top.
 * @param commit - The commit to read.
 * @param paths - What to list.
 */
export async function listTree(
  root: string,
  commit: string,
  paths: readonly string[]
): Promise<Map<string, { oid: string; mode: string }>> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (paths.length === 0) return out;
  // Literal: a file named like pathspec magic (`:(exclude)…`) is just a name.
  const raw = await git(root, [
    '--literal-pathspecs',
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    commit,
    '--',
    ...paths,
  ]);
  for (const record of raw.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, , oid] = record.slice(0, tab).split(' ');
    if (mode && oid) out.set(record.slice(tab + 1), { oid, mode });
  }
  return out;
}

/**
 * The repo-relative paths under `pathspecs` that differ between two commits.
 * `diff-tree --name-only` compares trees only, so no diff driver or filter
 * the repo configures ever runs.
 *
 * @param root - The repo's working tree top.
 * @param from - The older commit.
 * @param to - The newer one.
 * @param pathspecs - What to compare.
 * @param mode - `glob` for `**` patterns, `literal` for exact paths.
 */
export async function changedPaths(
  root: string,
  from: string,
  to: string,
  pathspecs: readonly string[],
  mode: 'glob' | 'literal'
): Promise<string[]> {
  const raw = await git(root, [
    mode === 'glob' ? '--glob-pathspecs' : '--literal-pathspecs',
    'diff-tree',
    '-r',
    '-z',
    '--name-only',
    '--no-renames',
    from,
    to,
    '--',
    ...pathspecs,
  ]);
  return raw.toString('utf8').split('\0').filter(Boolean);
}

/** git's empty tree, by object id length: what a commit is diffed against to list it. */
const EMPTY_TREE: Record<number, string> = {
  40: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  64: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/**
 * The files a commit has under glob `pathspecs` (`**` patterns), as path to
 * blob id and mode. `ls-tree` takes no pathspec magic, so this diffs the
 * commit against the empty tree, which lists every matching file as added.
 *
 * @param root - The repo's working tree top.
 * @param commit - The commit to read, as a full object id.
 * @param pathspecs - What to list, as git glob pathspecs.
 */
export async function listTreeMatching(
  root: string,
  commit: string,
  pathspecs: readonly string[]
): Promise<Map<string, { oid: string; mode: string }>> {
  const empty = EMPTY_TREE[commit.length];
  if (!empty) throw new Error(`Not a full object id: ${commit}`);
  const raw = await git(root, [
    '--glob-pathspecs',
    'diff-tree',
    '-r',
    '-z',
    '--raw',
    '--no-renames',
    '--no-abbrev',
    empty,
    commit,
    '--',
    ...pathspecs,
  ]);
  const out = new Map<string, { oid: string; mode: string }>();
  const fields = raw.toString('utf8').split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // ":000000 <mode> <zero id> <id> A", then the path.
    const [, mode, , oid] = fields[i].split(' ');
    if (mode && oid) out.set(fields[i + 1], { oid, mode });
  }
  return out;
}

/**
 * Whether any commit in `from..to` touched `pathspecs` (git pathspecs with
 * their own `:(glob)` or `:(literal)` magic).
 *
 * @param root - The repo's working tree top.
 * @param from - The older commit.
 * @param to - The newer one.
 * @param pathspecs - What may not have been touched.
 */
export async function touchedBetween(
  root: string,
  from: string,
  to: string,
  pathspecs: readonly string[]
): Promise<boolean> {
  const out = await git(root, ['rev-list', '--max-count=1', `${from}..${to}`, '--', ...pathspecs]);
  return out.toString('utf8').trim() !== '';
}

/**
 * One blob's bytes.
 *
 * @param root - The repo's working tree top.
 * @param oid - The blob id.
 */
export async function readBlob(root: string, oid: string): Promise<Buffer> {
  return git(root, ['cat-file', 'blob', oid]);
}

/**
 * The id git gives these bytes as a blob, computed here so no git filter runs:
 * sha1 for a 40-character repo, sha256 for a 64-character one.
 *
 * @param content - The file's bytes, as they are on disk.
 * @param oidLength - The length of an id in this repo (40 or 64).
 */
export function gitBlobId(content: Buffer, oidLength: number): string {
  const algorithm = oidLength === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm).update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}
