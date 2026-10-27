/**
 * The few git reads the repo settings check needs (DOR-3298), each one an
 * `execFile` with an argument list (no shell), a timeout, and the hardening
 * every git command DorkOS runs itself carries (`internalGitArgs`: no hooks,
 * no file-system monitor, no implicit bare repository).
 *
 * Only plumbing that runs no repository-configured program is used here:
 * `rev-parse`, `symbolic-ref`, `ls-tree`, `cat-file` and `merge-base`. Nothing
 * reads the working tree through git, so a repository's own clean filter or
 * diff driver is never started; working files are read by the caller and
 * hashed in-process ({@link gitBlobId}).
 *
 * @module services/runtimes/claude-code/repo-settings/repo-git
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { hardenedGitEnv, internalGitArgs } from '../../../../lib/git-safety.js';

const execFileAsync = promisify(execFile);

/** How long one git read may take. */
const GIT_TIMEOUT_MS = 5_000;

/** The most output one git read may return. Settings files are capped at 64 KB. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Switches that keep a repo's own files from changing what a commit holds or
 * descends from. An agent can write all of them: replace refs
 * (`git replace <commit> <its own>`) swap a commit's tree under the same id,
 * `info/grafts` rewrites parents, and a crafted commit-graph file can claim
 * parents a commit does not have. Forged pack or loose objects are not caught
 * here; that residual needs DorkOS's own copy of the default branch (DOR-3339).
 */
const BASELINE_GIT_ARGS = ['--no-replace-objects', '-c', 'core.commitGraph=false'];

/** The environment twin of {@link BASELINE_GIT_ARGS}, for the switches with no flag. */
const BASELINE_GIT_ENV = {
  GIT_NO_REPLACE_OBJECTS: '1',
  // A graft file that never exists, so the repo's `info/grafts` is never read.
  GIT_GRAFT_FILE: path.join(path.sep, 'nonexistent', 'dorkos-no-grafts'),
};

/** Thrown when git itself is not installed: the one case the check does not block on. */
export class GitMissingError extends Error {
  constructor() {
    super('git is not installed');
    this.name = 'GitMissingError';
  }
}

/**
 * Run one git command in `cwd` and return its stdout.
 *
 * @param cwd - The folder to run in.
 * @param args - The subcommand and its arguments.
 * @throws {GitMissingError} When git is not installed.
 * @throws Any other git failure, as `execFile` reports it.
 */
async function git(cwd: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...internalGitArgs(), ...BASELINE_GIT_ARGS, ...args],
      {
        cwd,
        env: { ...hardenedGitEnv(), ...BASELINE_GIT_ENV },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: 'buffer',
      }
    );
    return stdout;
  } catch (err) {
    // A spawn reports a missing folder the same way as a missing program: only
    // an existing folder means git itself is not there.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && existsSync(cwd)) {
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

/**
 * The repo a folder is in, or `null` when it is in none.
 *
 * @param cwd - The folder a turn launches in.
 * @throws {GitMissingError} When git is not installed.
 */
export async function locateRepo(cwd: string): Promise<RepoLocation | null> {
  // `--git-common-dir` may print a path relative to `cwd` on older git.
  const out = await gitText(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (!out) return null;
  const [root, commonDir] = out.split('\n');
  return root && commonDir ? { root, commonDir: path.resolve(cwd, commonDir) } : null;
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
