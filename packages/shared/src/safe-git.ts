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
 *    command, credential helper or ask-pass program, no submodule recursion:
 *    `status` and the `diff` family get `--ignore-submodules=all` on the command
 *    line, which wins over a `.gitmodules` `ignore` line in the work tree.
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
import { findGitPlaces, nativeRealPath, readGitFile } from './git-places.js';

export {
  findGitPlaces,
  type BrokenGitPointer,
  type FindGitPlacesOptions,
  type GitPlaces,
} from './git-places.js';

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
      // What `git submodule add` writes in the containing repository; a name
      // may hold any character but a line end. Never `submodule.*.update`,
      // which can name a command.
      'submodule\\.[^\\n]+\\.(?:url|active)',
      'extensions\\.(?:worktreeconfig|objectformat)',
      'blame\\.ignorerevsfile',
      'rerere\\.enabled',
      'lfs\\.repositoryformatversion',
      // Codex metadata, not a Git command/path setting. Apple Git-155 ignores it
      // (src/git/config.c git_default_config; DOR-4486). Keep this one key exact.
      'codex\\.localenvironmentconfigpath',
      // Named keys only, never a whole section: `gc.recentObjectsHook` is a
      // shell command gc runs, and a commit or fetch can start gc by itself
      // (DOR-3667). `gtr.*` is read by git-worktree-runner, never by git; its
      // hook and editor keys name programs, so they are left out too.
      'gtr\\.(?:worktrees\\.(?:dir|prefix)|defaults\\.branch|copy\\.(?:include|exclude|includedirs|excludedirs))',
      'gc\\.(?:auto|autopacklimit|autodetach|aggressivedepth|aggressivewindow|bigpackthreshold|cruftpacks|maxcruftsize|logexpiry|packrefs|pruneexpire|worktreepruneexpire|reflogexpire|reflogexpireunreachable|rerereresolved|rerereunresolved|writecommitgraph)',
      'maintenance\\.(?:auto|autodetach|strategy|(?:gc|commit-graph|prefetch|loose-objects|incremental-repack|pack-refs|reflog-expire|worktree-prune|rerere-gc)\\.(?:enabled|schedule|auto)|loose-objects\\.batchsize)',
      'fetch\\.(?:prune|writecommitgraph)',
      'pull\\.rebase',
      'user\\.(?:name|email)',
    ].join('|') +
    ')$'
);

/**
 * Whether one config key may stand in a DorkOS room repo's shared config
 * (DOR-3667): {@link SAFE_REPO_CONFIG_KEY}, minus `extensions.worktreeConfig`,
 * which would make each copy's own agent-writable `config.worktree` part of
 * what git reads, and minus the `submodule.*` keys, which a room never needs. Anything else (a filter, a driver, an include, a helper, a
 * hook path, a promisor remote with its own `uploadpack`,
 * `extensions.partialClone`) stops the server's git in that room.
 *
 * @param key - One key name, as `git config --list` prints it.
 */
export function isSafeRoomRepoConfigKey(key: string): boolean {
  return (
    SAFE_REPO_CONFIG_KEY.test(key) &&
    !/^extensions\.worktreeconfig$/i.test(key) &&
    !/^submodule\./i.test(key)
  );
}

/**
 * The environment that keeps a git command from reaching any remote (DOR-3667):
 * no lazy fetch of a missing object, and no transport at all. For git that
 * reads repos DorkOS did not make and never needs to fetch.
 */
export const NO_REACH_GIT_ENV: Readonly<
  Record<'GIT_NO_LAZY_FETCH' | 'GIT_ALLOW_PROTOCOL', string>
> = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };

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
];

/** The subcommands that look at the work tree's submodules, unless told not to. */
const SUBMODULE_READERS = new Set(['status', 'diff', 'diff-files', 'diff-index']);

/**
 * git's own options, before the subcommand, that take their value as the next
 * argument: what a caller skips, value and all, to find the subcommand.
 */
export const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

/**
 * `args` with `--ignore-submodules=all` right after a {@link SUBMODULE_READERS}
 * subcommand: on the command line it wins over a `.gitmodules` `ignore` line,
 * which `-c diff.ignoreSubmodules=all` does not.
 *
 * @throws {Error} When the caller passes `--ignore-submodules` itself.
 */
function withSubmodulesIgnored(args: readonly string[]): readonly string[] {
  let at = 0;
  while (at < args.length && args[at].startsWith('-')) {
    at += GIT_OPTIONS_WITH_VALUE.has(args[at]) ? 2 : 1;
  }
  if (!SUBMODULE_READERS.has(args[at] ?? '')) return args;
  if (args.some((arg) => arg.startsWith('--ignore-submodules'))) {
    throw new Error('The safe git runner sets --ignore-submodules itself.');
  }
  return [...args.slice(0, at + 1), '--ignore-submodules=all', ...args.slice(at + 1)];
}

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
  /**
   * The work tree to give git with `--work-tree`, which wins over a repository's own
   * `core.worktree`. That key is then accepted when it names the checkout whose
   * `.git` file leads back to its git folder, as a submodule's does.
   */
  workTree?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const AUDIT_TIMEOUT_MS = 5_000;

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
const auditedAt = new Map<
  string,
  { stamp: string; worktreeConfig: boolean; workTree: string | undefined }
>();

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

/** The value a settings file gives `core.worktree`; `null` if git can't read it. */
function workTreeIn(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['config', '--file', file, '--no-includes', '--get', 'core.worktree'],
      { cwd: path.parse(file).root, timeout: AUDIT_TIMEOUT_MS, env: minimalGitEnv() },
      (err, stdout) => resolve(err ? null : stdout.replace(/[\r\n]+$/, ''))
    );
  });
}

/**
 * Whether a `core.worktree` set in `gitDir`'s settings names the checkout whose
 * `.git` file leads back to `gitDir`, as `git submodule add` lays one out.
 */
function workTreeLeadsBack(gitDir: string, workTree: string): boolean {
  const top = path.resolve(gitDir, workTree);
  const text = readGitFile(path.join(top, '.git'));
  if (text === null || !text.startsWith('gitdir: ')) return false;
  const back = path.resolve(top, text.slice('gitdir: '.length));
  return nativeRealPath(back) === nativeRealPath(gitDir);
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
  /**
   * Also accept a `core.worktree` that names the checkout whose `.git` file leads
   * back to that git folder, as a submodule's does. Only the read runner sets
   * it, for a call that gives git `--work-tree` itself, which wins over the
   * repository's value. One that names any other folder is still refused.
   */
  allowWorkTree?: boolean;
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
 * @param options - Whether `core.hooksPath` and `core.worktree` are accepted (reads only).
 * @throws {GitRepoConfigUnsafeError} When a settings file sets a key off the
 *   list, cannot be read, or a `.git` pointer cannot be followed.
 */
export async function assertRepoConfigSafe(
  cwd: string,
  options: RepoConfigAuditOptions = {}
): Promise<void> {
  const places = findGitPlaces(cwd);
  if (places === null) throw new GitRepoConfigUnsafeError(path.join(cwd, '.git'), []);
  let worktreeConfigOn = false;
  for (const gitDir of places.gitDirs) {
    const passed = await auditFile(path.join(gitDir, 'config'), options);
    worktreeConfigOn ||= passed.worktreeConfig;
  }
  if (!worktreeConfigOn) return;
  for (const gitDir of places.gitDirs) {
    await auditFile(path.join(gitDir, 'config.worktree'), options);
  }
}

/**
 * Audit one settings file, or answer from the cache when it has not changed.
 * Answers whether it names `extensions.worktreeConfig`.
 */
async function auditFile(
  file: string,
  { allowHooksPath = false, allowWorkTree = false }: RepoConfigAuditOptions
): Promise<{ worktreeConfig: boolean }> {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return { worktreeConfig: false };
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const cacheKey = [file, allowHooksPath ? 'read' : '', allowWorkTree ? 'tree' : ''].join('\0');
  let entry = auditedAt.get(cacheKey);
  if (entry?.stamp !== stamp) {
    auditedAt.delete(cacheKey);
    const keys = await keysIn(file);
    const unsafe = keys.filter(
      (key) =>
        !SAFE_REPO_CONFIG_KEY.test(key) &&
        !(allowHooksPath && key === 'core.hookspath') &&
        !(allowWorkTree && key === 'core.worktree')
    );
    if (unsafe.length > 0) throw new GitRepoConfigUnsafeError(file, unsafe);
    let workTree: string | undefined;
    if (keys.includes('core.worktree')) {
      const value = await workTreeIn(file);
      if (value === null) throw new GitRepoConfigUnsafeError(file, ['core.worktree']);
      workTree = value;
    }
    entry = { stamp, worktreeConfig: keys.includes('extensions.worktreeconfig'), workTree };
    auditedAt.set(cacheKey, entry);
  }
  // Checked on every call: the `.git` file it leads to is not part of the stamp.
  if (entry.workTree !== undefined && !workTreeLeadsBack(path.dirname(file), entry.workTree)) {
    throw new GitRepoConfigUnsafeError(file, ['core.worktree']);
  }
  return { worktreeConfig: entry.worktreeConfig };
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
  const workTree = options.workTree === undefined ? [] : [`--work-tree=${options.workTree}`];
  await assertRepoConfigSafe(cwd, { allowHooksPath: true, allowWorkTree: workTree.length > 0 });
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_GIT_ARGS, ...workTree, ...withSubmodulesIgnored(args)],
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
