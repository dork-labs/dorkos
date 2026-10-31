/**
 * The one way DorkOS reads a git repository it did not make (DOR-3343).
 *
 * Git reads a repository's own settings, and some of them name a program git
 * runs: a filter, a diff driver, an ssh command, a credential helper, a file
 * monitor. When an agent can write the repository, those settings are the
 * agent's choice, and a read DorkOS runs would run them as the server. The
 * hardening in `git-hardening.ts` switches off the settings whose names are
 * known in advance; a filter or driver name is the author's own, so this
 * runner audits instead:
 *
 * 1. **Audit first.** Every settings file git could read for the folder — each
 *    `.git` folder's `config` and `config.worktree` from the folder up, and for
 *    a `.git` file the git folder and shared `commondir` it names — is listed
 *    key by key. Any key outside {@link SAFE_REPO_CONFIG_KEY} refuses the call
 *    with {@link GitRepoConfigUnsafeError}, before git runs. Includes are
 *    refused, never followed. The list is DorkOS Security's `dork-ro` list.
 * 2. **Nothing reaches out.** No lazy fetch (`GIT_NO_LAZY_FETCH`), no transport
 *    at all (`protocol.allow=never` and an empty `GIT_ALLOW_PROTOCOL`), no ssh
 *    command, credential helper or ask-pass program, no submodule recursion.
 * 3. **A minimal environment.** Only what git needs to start (`PATH`, `HOME`,
 *    locale and temp folders), and never the system's or person's global git
 *    settings, so nothing the server process carries reaches git or a program.
 *
 * What this does not claim:
 * - **The audit and git do not run at the same instant.** A process rewriting a
 *   settings file in the gap between the audit and git starting wins. That is
 *   why DorkOS also refuses to run git at all in folders an agent can write
 *   (`mayRunGitHere` in the server), which stays the first line there; this
 *   runner is the second, and the only one for folders that are nobody's.
 * - The audit is cached by size and times, so a file rewritten with the same
 *   size inside one timestamp tick on a coarse-clock file system is not re-read.
 * - `git` itself is found on `PATH`, and git older than 2.38 ignores
 *   `safe.bareRepository` (the startup health check warns about that git).
 *
 * @module shared/safe-git
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitConfigArgs, internalGitConfig } from './git-hardening.js';

/**
 * The only keys a repository's own settings may hold for DorkOS to read it
 * with git. Matched against the lower-cased key name, whole. Anything else (a
 * filter, a driver, an include, a helper, an alias, a partial-clone remote)
 * refuses the read.
 */
export const SAFE_REPO_CONFIG_KEY = new RegExp(
  '^(?:' +
    [
      'core\\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)',
      'remote\\.[a-z0-9._-]+\\.(?:url|pushurl|fetch|push|tagopt|prune|gh-resolved)',
      // Git never runs a command from a `branch.*` key.
      'branch\\.[a-z0-9._/-]+\\.[a-z0-9-]+',
      'extensions\\.(?:worktreeconfig|objectformat)',
      'blame\\.ignorerevsfile',
      'rerere\\.enabled',
      'lfs\\.repositoryformatversion',
      'gtr\\.[a-z.]+',
      'gc\\.[a-z]+',
      'maintenance\\.[a-z.]+',
      'fetch\\.(?:prune|writecommitgraph)',
      'pull\\.rebase',
      'user\\.(?:name|email)',
    ].join('|') +
    ')$'
);

/** Settings that keep a read from reaching out or recursing, on top of the hardening. */
const SAFE_GIT_ARGS: readonly string[] = [
  ...gitConfigArgs(internalGitConfig()),
  '-c',
  'protocol.allow=never',
  '-c',
  'core.sshCommand=',
  '-c',
  'core.askPass=',
  '-c',
  'credential.helper=',
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'status.submoduleSummary=false',
  '-c',
  'submodule.recurse=false',
];

/** Thrown when a repository's own settings hold a key off the safe list. */
export class GitRepoConfigUnsafeError extends Error {
  /**
   * Build the error.
   *
   * @param file - The settings file that holds the keys.
   * @param keys - The keys off the safe list (empty when the file was unreadable).
   */
  constructor(
    readonly file: string,
    readonly keys: readonly string[]
  ) {
    super(
      keys.length > 0
        ? `DorkOS won't read this repository with git: ${file} sets ${keys.join(', ')}.`
        : `DorkOS won't read this repository with git: ${file} can't be read.`
    );
    this.name = 'GitRepoConfigUnsafeError';
  }
}

/** How one {@link runSafeGit} call runs. */
export interface SafeGitOptions {
  /** Kill git after this long. Default 10 seconds. */
  timeoutMs?: number;
  /** The most output to keep. Default 10 MB. */
  maxBuffer?: number;
  /** Stop early. */
  signal?: AbortSignal;
  /**
   * The locale for git, such as `LC_ALL=C` for a caller that reads git's error
   * text. Only `LC_ALL` and `LANG` are taken; nothing else can be set.
   */
  env?: Readonly<Partial<Record<'LC_ALL' | 'LANG', string>>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const AUDIT_TIMEOUT_MS = 5_000;

/** Where git could read settings from for one folder (see {@link findGitPlaces}). */
export interface GitPlaces {
  /** The folder, and every folder above it that holds a `.git`. */
  folders: string[];
  /** Every git folder: `.git` folders, the git folders `.git` files name, and their `commondir`s. */
  gitDirs: string[];
  /**
   * Every linked worktree of each repository found. A repository's worktrees
   * share its one settings file, so whoever can write one can change what git
   * reads in all of them.
   */
  worktrees: string[];
}

/**
 * Every place git could read settings from for `dir`, from the filesystem
 * alone: the folder, each folder above it holding a `.git` (from both its
 * spelled and its real path, since git climbs past a `.git` that is not a real
 * repository), the git folder and `commondir` each `.git` file names, and each
 * repository's linked worktrees. `null` when a `.git` file cannot be read as a
 * pointer.
 *
 * @param dir - The folder git would run in.
 */
export function findGitPlaces(dir: string): GitPlaces | null {
  const resolved = path.resolve(dir);
  const folders = new Set([resolved]);
  const gitDirs = new Set<string>();
  const commonDirs = new Set<string>();
  for (const start of new Set([resolved, nativeRealPath(resolved)])) {
    // Inside a git folder itself, git reads that folder as a repository of its
    // own (`.git/modules/x`, `.git/worktrees/x`). DorkOS never needs to.
    if (start.split(path.sep).includes('.git')) return null;
    folders.add(start);
    for (let current = start; ; current = path.dirname(current)) {
      // A folder shaped like a git folder is one git may read as a repository.
      if (looksLikeGitDir(current)) gitDirs.add(current);
      const dotGit = path.join(current, '.git');
      const stat = fs.lstatSync(dotGit, { throwIfNoEntry: false });
      if (stat) {
        folders.add(current);
        const common = stat.isDirectory() ? dotGit : addPointer(current, dotGit, gitDirs);
        if (common === null) return null;
        gitDirs.add(common);
        commonDirs.add(common);
      }
      if (path.dirname(current) === current) break;
    }
  }
  const worktrees = new Set<string>();
  for (const common of commonDirs) addLinkedWorktrees(common, worktrees);
  return { folders: [...folders], gitDirs: [...gitDirs], worktrees: [...worktrees] };
}

/**
 * Add the git folder a `.git` file names, and answer the repository's shared
 * folder (its `commondir`); `null` if the file names none, or names a folder
 * that is not there. Read exactly as git reads it: `gitdir: ` (one space) at
 * the very start, then the path up to the line ends stripped from the end,
 * with no other trimming, so the audit reads the same folder git does.
 */
function addPointer(top: string, dotGit: string, gitDirs: Set<string>): string | null {
  const text = readGitFile(dotGit);
  if (text === null || !text.startsWith('gitdir: ')) return null;
  const gitDir = path.resolve(top, text.slice('gitdir: '.length));
  if (!isDirectory(gitDir)) return null;
  gitDirs.add(gitDir);
  const common = readGitFile(path.join(gitDir, 'commondir'));
  if (common === null) return gitDir; // A submodule's git folder is its own common folder.
  const commonDir = path.resolve(gitDir, common);
  return isDirectory(commonDir) ? commonDir : null;
}

/** A file's text with trailing line ends stripped, as git reads its pointer files; `null` if unreadable. */
function readGitFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').replace(/[\r\n]+$/, '');
  } catch {
    return null;
  }
}

function isDirectory(dir: string): boolean {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** Whether a folder has the shape git accepts as a git folder: `HEAD`, `objects` and `refs`. */
function looksLikeGitDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'HEAD')) &&
    isDirectory(path.join(dir, 'objects')) &&
    isDirectory(path.join(dir, 'refs'))
  );
}

/**
 * Add the folder of every linked worktree a repository lists: each
 * `<common>/worktrees/<name>/gitdir` names that worktree's `.git` file. An
 * entry that cannot be read is one git cannot use either.
 */
function addLinkedWorktrees(common: string, worktrees: Set<string>): void {
  const admin = path.join(common, 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(admin);
  } catch {
    return;
  }
  for (const name of names) {
    // No gitdir file: a half-made or pruned entry, which git cannot use either.
    const dotGit = readGitFile(path.join(admin, name, 'gitdir'));
    if (dotGit) worktrees.add(path.dirname(path.resolve(admin, name, dotGit)));
  }
}

function nativeRealPath(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * The minimal environment the runner starts git with: only what git needs to
 * start, no system or global git settings, no lazy fetch, no transport, no
 * prompt. Exported for the few git writes that audit first with
 * {@link assertRepoConfigSafe} but cannot use the runner's read-only settings
 * (making and removing a workspace).
 *
 * @param locale - `LC_ALL` and `LANG` for git, if the caller reads its error text.
 */
export function minimalGitEnv(locale: SafeGitOptions['env'] = {}): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-restricted-syntax -- the runner picks the few variables git needs to start; nothing else of the server's environment reaches git.
  const parent = process.env;
  const env: NodeJS.ProcessEnv = {};
  if (locale.LC_ALL !== undefined) env.LC_ALL = locale.LC_ALL;
  if (locale.LANG !== undefined) env.LANG = locale.LANG;
  for (const name of [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'SYSTEMROOT',
    'USERPROFILE',
    'PATHEXT',
    'ComSpec',
  ]) {
    if (parent[name] !== undefined && env[name] === undefined) env[name] = parent[name];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    GIT_TERMINAL_PROMPT: '0',
    // No GIT_OPTIONAL_LOCKS=0: `status` must be free to write back its
    // refreshed index, as git always does. Without that, every file in a fresh
    // checkout stays "racily clean" and each status re-reads all of them (on a
    // fresh 20k-file checkout, 0.6 s every time against 0.09 s once written).
    // A caller reading someone else's live worktree passes `--no-optional-locks`
    // itself (the Workspaces scan does).
    GIT_PAGER: 'cat',
  };
}

/** The last stat each settings file passed the audit at. */
const auditedAt = new Map<string, { stamp: string; worktreeConfig: boolean }>();

/** The keys a settings file sets that are off the safe list. */
function keysIn(file: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['config', '--file', file, '--no-includes', '--name-only', '--list', '-z'],
      // Run from the file system root: `--file` reads only that file, and no
      // repository is found above `/` to add its own settings.
      { cwd: path.parse(file).root, timeout: AUDIT_TIMEOUT_MS, env: minimalGitEnv() },
      (err, stdout) => {
        if (err) return reject(new GitRepoConfigUnsafeError(file, []));
        resolve([
          ...new Set(
            stdout
              .split('\0')
              .map((key) => key.trim().toLowerCase())
              .filter((key) => key !== '')
          ),
        ]);
      }
    );
  });
}

/** How {@link assertRepoConfigSafe} judges one repository. */
export interface RepoConfigAuditOptions {
  /**
   * Also accept `core.hooksPath` (husky writes one). Only the read runner
   * sets it: every read passes `-c core.hooksPath=/dev/null`, so the
   * repository's own value changes nothing there. A workspace write keeps a
   * person's hooks, so there the key stays refused (DOR-3345).
   */
  allowHooksPath?: boolean;
}

/**
 * Refuse a folder whose repository settings hold any key off the safe list.
 * Cached per settings file by its size and times, separately for each way of
 * judging it.
 *
 * Each git folder's `config` is always audited. Its `config.worktree` is
 * audited only when an audited `config` names `extensions.worktreeConfig`,
 * which is the only time git reads that file: `git sparse-checkout disable`
 * leaves sparse-checkout keys there, and a checkout that then turns the
 * extension off (as GitHub's checkout action does) is not refused for a file
 * git never opens.
 *
 * @param cwd - The folder git would run in.
 * @param options - Whether `core.hooksPath` is accepted (reads only).
 * @throws {GitRepoConfigUnsafeError} When a settings file sets a key off the
 *   list, cannot be read, or a `.git` pointer cannot be followed.
 */
export async function assertRepoConfigSafe(
  cwd: string,
  { allowHooksPath = false }: RepoConfigAuditOptions = {}
): Promise<void> {
  const places = findGitPlaces(cwd);
  if (places === null) throw new GitRepoConfigUnsafeError(path.join(cwd, '.git'), []);
  let worktreeConfigOn = false;
  for (const gitDir of places.gitDirs) {
    const passed = await auditFile(path.join(gitDir, 'config'), allowHooksPath);
    worktreeConfigOn ||= passed.worktreeConfig;
  }
  if (!worktreeConfigOn) return;
  for (const gitDir of places.gitDirs) {
    await auditFile(path.join(gitDir, 'config.worktree'), allowHooksPath);
  }
}

/**
 * Audit one settings file, or answer from the cache when it has not changed.
 * Answers whether it names `extensions.worktreeConfig`.
 */
async function auditFile(
  file: string,
  allowHooksPath: boolean
): Promise<{ worktreeConfig: boolean }> {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return { worktreeConfig: false };
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const cacheKey = allowHooksPath ? `${file}\0read` : file;
  const cached = auditedAt.get(cacheKey);
  if (cached?.stamp === stamp) return { worktreeConfig: cached.worktreeConfig };
  const keys = await keysIn(file);
  const unsafe = keys.filter(
    (key) => !SAFE_REPO_CONFIG_KEY.test(key) && !(allowHooksPath && key === 'core.hookspath')
  );
  if (unsafe.length > 0) {
    auditedAt.delete(cacheKey);
    throw new GitRepoConfigUnsafeError(file, unsafe);
  }
  const worktreeConfig = keys.includes('extensions.worktreeconfig');
  auditedAt.set(cacheKey, { stamp, worktreeConfig });
  return { worktreeConfig };
}

/**
 * Run a read-only git command in `cwd` through the audit, the settings and the
 * minimal environment above. Resolves git's stdout untrimmed; rejects on a
 * non-zero exit (with git's `code` and `stderr` on the error) or a refused
 * repository.
 *
 * @param args - git's arguments, after the runner's own settings.
 * @param cwd - The folder git runs in.
 * @param options - Timeout, output cap, abort and extra environment.
 */
export async function runSafeGit(
  args: readonly string[],
  cwd: string,
  options: SafeGitOptions = {}
): Promise<string> {
  const out = await spawnSafeGit(args, cwd, options, 'utf8');
  return out as string;
}

/**
 * {@link runSafeGit} for bytes: a file's content at a commit, say.
 *
 * @param args - git's arguments, after the runner's own settings.
 * @param cwd - The folder git runs in.
 * @param options - Timeout, output cap, abort and extra environment.
 */
export async function runSafeGitBuffer(
  args: readonly string[],
  cwd: string,
  options: SafeGitOptions = {}
): Promise<Buffer> {
  const out = await spawnSafeGit(args, cwd, options, 'buffer');
  return out as Buffer;
}

async function spawnSafeGit(
  args: readonly string[],
  cwd: string,
  options: SafeGitOptions,
  encoding: 'utf8' | 'buffer'
): Promise<string | Buffer> {
  await assertRepoConfigSafe(cwd, { allowHooksPath: true });
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_GIT_ARGS, ...args],
      {
        cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        signal: options.signal,
        env: minimalGitEnv(options.env),
        encoding,
      },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout, stderr });
          return reject(err);
        }
        resolve(stdout);
      }
    );
  });
}
