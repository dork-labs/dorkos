/**
 * The git commands a room's own repo is made of (spec `project-rooms` §3.1).
 *
 * Its own module for the reason `services/workspace/providers/git.ts` is one:
 * everything above it should read as intent — "make a repo", "commit this as
 * the operator" — while the flags that make those safe live in exactly one
 * place. The rooms domain does not reuse the workspace module because the two
 * answer different questions: that one computes a workspace's dirty state for
 * the cleanup gate, this one creates and writes a repo DorkOS owns.
 *
 * ## What the hardening actually buys, measured rather than assumed
 *
 * Every command goes through {@link runGit}, which applies one shared argument
 * prefix and builds an explicit environment. Each piece is here because it was
 * observed to matter, and none of them claims more than that:
 *
 * - **`GIT_CEILING_DIRECTORIES=<room home>` — the one that was a live bug.**
 *   Git discovers a repository by walking UP from the working directory, so a
 *   directory under `worktrees/` that is not a checkout answers for whatever
 *   repository encloses the DorkOS data directory. In the dev layout
 *   (`apps/server/.temp/.dork/`) that is the dorkos checkout itself, so
 *   `hasUncommittedChanges` on a junk worktree reported the DORKOS repo's state
 *   and `commitsAheadOfMain` answered against its `main`. The delete guard
 *   would then have called a stranded directory clean. The ceiling stops the
 *   walk at the room's own home; a directory that is not a checkout now fails
 *   with "not a git repository", which the callers treat as unreadable.
 *   Linked worktrees are unaffected — their `.git` file names the main repo's
 *   gitdir by absolute path rather than by traversal, verified against a real
 *   `git worktree add`.
 * - **`GIT_DIR` and its family are stripped from the child environment.** An
 *   inherited `GIT_DIR` points a command at another repository's storage:
 *   measured, `GIT_DIR=<other>/.git git init -b main <new>` re-initialises the
 *   OTHER repo, exits 0, warns only about the ignored branch name, and leaves
 *   `<new>` empty — a success this module would have believed. `GIT_WORK_TREE`,
 *   `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
 *   `GIT_COMMON_DIR` and `GIT_NAMESPACE` are the same hazard by other names.
 * - **`-c core.hooksPath=/dev/null` on every command, and `--no-verify` on
 *   commit.** These are not the same guarantee, and the earlier version of this
 *   header said they were. Measured: `--no-verify` skips only `pre-commit` and
 *   `commit-msg` — a `post-commit` hook still ran, and printed. `core.hooksPath`
 *   is what actually stops it, because it points hook lookup at a path that
 *   holds none. `--no-verify` stays as the second line: it costs nothing and
 *   covers the hooks it does cover if the config override is ever lost.
 * - **`-c core.fsmonitor=false`.** A repo-local `core.fsmonitor` is a command
 *   git executes on an ordinary `git status`; measured, it ran twice on one
 *   status. Since a room repo's config is reachable by anything that can write
 *   into the checkout, this is the config value that turns a read into an
 *   execution.
 * - **`-c init.templateDir=` on `init`.** Without it, `git init` copies the
 *   machine's global template — hooks included — into every room repo on the
 *   install.
 * - **`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null`.** The
 *   room repo behaves the same on every machine, so a person's own global git
 *   config cannot change what DorkOS commits or how it reads a worktree.
 *
 * **What none of this claims:** a repo-local `.git/hooks/` directory that some
 * other program populated is neutralised by `core.hooksPath`, but nothing here
 * inspects a checkout for hostile content, and a merge is not made safe by this
 * module — the tree validation spec §3.6 calls for is task 2.3's.
 *
 * Nothing here takes a remote, so `hardenedGitEnv` (the transport allowlist for
 * author-supplied URLs) has nothing to protect: an owned repo is created empty
 * and never fetches.
 *
 * @module server/services/rooms/repo/room-repo-git
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * How long one git command may take before it is killed.
 *
 * The same 30s the workspace providers use. Every command here runs against a
 * local directory with no network in it, so the timeout is a stuck-process
 * backstop rather than a budget.
 */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Config overrides applied to EVERY command, ahead of the subcommand.
 *
 * `-c` rather than writing them into the repo's own config, because the repo's
 * config is a file member-written content can reach and these two are exactly
 * the values that turn reading a checkout into running code. See the module
 * doc for what each was measured to stop.
 */
const SHARED_CONFIG_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/**
 * Environment variables that point a git command at a DIFFERENT repository's
 * storage, and are therefore removed rather than passed through.
 *
 * Not a hardening nicety: an inherited `GIT_DIR` was measured to make `git
 * init` re-initialise the wrong repository and report success.
 */
const REDIRECTING_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
] as const;

/**
 * The name a commit DorkOS makes on the operator's behalf is authored under
 * when this install has no name for them yet.
 *
 * Deliberately not the room author registry's label for the owner, which
 * `bindOwner` fixes at `'You'` forever — the right word in the person's own
 * window, and a bizarre one in `git log`.
 */
export const FALLBACK_OPERATOR_GIT_NAME = 'DorkOS operator';

/**
 * The email address every operator commit in a room repo carries.
 *
 * Git demands an address and DorkOS has none: an account here is a local login,
 * not a mailbox. A `.local` address is reserved by RFC 6762 and can never
 * resolve, so it cannot be mistaken for a real one or accidentally mailed.
 */
export const OPERATOR_GIT_EMAIL = 'operator@dorkos.local';

/**
 * Raised when this machine has no `git` at all.
 *
 * Its own type because it is the one git failure that is not about the repo: no
 * retry, no other room, and nothing the person can fix inside DorkOS. Callers
 * translate it into a refusal that says so.
 */
export class GitUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('git is not installed on this machine, or is not on the server’s PATH');
    this.name = 'GitUnavailableError';
    this.cause = cause;
  }
}

/** Who a commit is attributed to. */
export interface GitIdentity {
  /** The name `git log` shows. */
  name: string;
  /** The address beside it. */
  email: string;
}

/**
 * The environment one git command runs in.
 *
 * Built from the parent's rather than replaced wholesale, because git needs
 * `PATH` and `HOME` — and then every variable that could redirect it at another
 * repository is dropped and the confinement is layered on top.
 *
 * @param ceilingDir - The directory git's repository search may not climb past.
 * @returns The child environment.
 */
function gitEnv(ceilingDir: string): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-restricted-syntax -- git must inherit PATH/HOME; this REMOVES the redirecting vars and adds the confinement, which is only expressible against the real environment.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REDIRECTING_GIT_VARS) delete env[name];
  return {
    ...env,
    // Absolute, and the room's own home: git stops the upward search here
    // rather than reaching whatever repository encloses the data directory.
    GIT_CEILING_DIRECTORIES: ceilingDir,
    // One machine's git config must not change what a room repo does.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    // Nothing here talks to a remote; a credential prompt would only hang.
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * How much output one git command may produce before it is killed.
 *
 * Node's own default is 1 MB, which is far too small here for two reasons that
 * have nothing to do with each other: reading a file out of a commit answers
 * its whole contents (capped by `config.rooms.repo.maxFileBytes`, 5 MB by
 * default), and one history walk over a busy directory prints a line per file
 * per commit. So the default is generous — and it is still a CAP, not a
 * licence: a command that runs past it is killed rather than allowed to grow
 * the server's heap without bound, which is exactly what a room full of
 * member-written content needs. Callers that know their own ceiling (a file
 * read does) pass a tighter one.
 */
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** What one git invocation may be tuned with. */
export interface RunGitOptions {
  /**
   * Output ceiling in bytes, defaulting to {@link GIT_MAX_OUTPUT_BYTES}. Past
   * it the child is killed and the call rejects with
   * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
   */
  maxBuffer?: number;
}

/**
 * Run one git command in `cwd` and answer its stdout as raw BYTES.
 *
 * The primitive {@link runGit} is built on, and the one to reach for whenever
 * the output is content rather than a value: `git cat-file blob` answers a
 * file, and a file is bytes — decoding it as UTF-8 would corrupt anything that
 * is not text, and trimming it would silently drop a trailing newline the
 * person actually wrote.
 *
 * @param args - Arguments after `git`, without the shared config prefix.
 * @param cwd - The directory to run in. Must exist.
 * @param ceilingDir - The room home directory git's repository search may not
 *   climb past. Required rather than defaulted: a caller that forgets it is a
 *   caller reading somebody else's repository, which is the bug this exists to
 *   prevent.
 * @param options - Per-call tuning. See {@link RunGitOptions}.
 * @returns Raw stdout.
 * @throws {GitUnavailableError} When there is no `git` on this machine.
 * @throws When git exits non-zero, the timeout elapses, or the output cap is hit.
 */
export async function runGitRaw(
  args: string[],
  cwd: string,
  ceilingDir: string,
  options: RunGitOptions = {}
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync('git', [...SHARED_CONFIG_ARGS, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(ceilingDir),
      maxBuffer: options.maxBuffer ?? GIT_MAX_OUTPUT_BYTES,
      // Bytes, not characters: this function's whole purpose is to answer what
      // git wrote rather than what a decoder made of it.
      encoding: 'buffer',
    });
    return stdout;
  } catch (err) {
    // `ENOENT` from `execFile` is the BINARY, not a missing path: the cwd is
    // checked by the caller and a missing repo exits 128 with a message.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new GitUnavailableError(err);
    throw err;
  }
}

/**
 * Run one git command in `cwd` and answer its trimmed stdout.
 *
 * The reader for VALUES — a sha, a branch name, a porcelain status. For file
 * contents use {@link runGitRaw}, whose output this one trims and decodes.
 *
 * @param args - Arguments after `git`, without the shared config prefix.
 * @param cwd - The directory to run in. Must exist.
 * @param ceilingDir - The room home directory git's repository search may not
 *   climb past. Required rather than defaulted: a caller that forgets it is a
 *   caller reading somebody else's repository, which is the bug this exists to
 *   prevent.
 * @param options - Per-call tuning. See {@link RunGitOptions}.
 * @returns Trimmed stdout.
 * @throws {GitUnavailableError} When there is no `git` on this machine.
 * @throws When git exits non-zero or the timeout elapses.
 */
export async function runGit(
  args: string[],
  cwd: string,
  ceilingDir: string,
  options: RunGitOptions = {}
): Promise<string> {
  return (await runGitRaw(args, cwd, ceilingDir, options)).toString('utf-8').trim();
}

/**
 * Create an empty repo whose default branch is `main`, with no hooks in it.
 *
 * `-b main` rather than a rename afterwards, so the branch is right before the
 * first commit exists and the sidecar's `defaultBranch: 'main'` is a statement
 * of fact rather than a hope.
 *
 * @param repoDir - The directory to initialise. Created by the caller.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function initRepo(repoDir: string, ceilingDir: string): Promise<void> {
  await runGit(
    ['-c', 'init.templateDir=', 'init', '-b', 'main', '--quiet', '.'],
    repoDir,
    ceilingDir
  );
}

/**
 * Whether a checkout has a `main` branch at all.
 *
 * Its own probe rather than an inference from a failure, so that "this repo has
 * no main yet" and "this command failed" stop being the same answer (they were,
 * and the second one silently read as zero unmerged commits).
 *
 * @param checkoutDir - The checkout to ask.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function hasMainBranch(checkoutDir: string, ceilingDir: string): Promise<boolean> {
  return hasLocalBranch(checkoutDir, 'main', ceilingDir);
}

/**
 * Whether a checkout has a local branch by this name.
 *
 * The general form of {@link hasMainBranch}, and the reason the worktree
 * manager can tell "this agent has never had a worktree here" from "the reap
 * removed the worktree and left the branch behind": those need opposite
 * `git worktree add` invocations, and picking by catching a failure would make
 * every OTHER failure look like the same case.
 *
 * @param checkoutDir - The checkout to ask.
 * @param branch - The branch name, without `refs/heads/`.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function hasLocalBranch(
  checkoutDir: string,
  branch: string,
  ceilingDir: string
): Promise<boolean> {
  try {
    await runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      checkoutDir,
      ceilingDir
    );
    return true;
  } catch (err) {
    if (err instanceof GitUnavailableError) throw err;
    // `--verify --quiet` exits 1 with no output for a ref that is not there.
    // Anything else — an unreadable directory, a corrupt repo — is not this
    // question's to swallow, so it goes back to the caller.
    if ((err as { code?: unknown })?.code === 1) return false;
    throw err;
  }
}

/**
 * Strip the control characters out of a name or an address a commit will carry.
 *
 * **A commit's author is not DorkOS's own text.** It is a person's profile name
 * or an agent's, and both are member-writable; `config_patch` can set the
 * first mid-conversation, and an agent's own worktree can be given any
 * `user.name` at all. What comes out the other end is `git log` output, which
 * DorkOS then PARSES — the room files API separates a commit's fields with
 * `U+001F`, so a name holding one shifts every field after it and a reader is
 * shown an author and a subject that were never committed together (measured:
 * display corruption, in the room's own file explorer).
 *
 * So the fix is at the source, where the ambiguity is created rather than where
 * it is discovered: nothing that is not printable text reaches a commit header.
 * The parser checks the shape of what it reads as well, because two closures on
 * a trust boundary is the right number, but this is the one that means no
 * DorkOS-written commit can ever be ambiguous.
 *
 * C0 (`U+0000`–`U+001F`), `DEL` and C1 (`U+0080`–`U+009F`) all go: git itself
 * rejects a newline in `user.name`, and the rest are invisible to a reader and
 * meaningful to a parser, which is the whole hazard. Everything printable —
 * accents, ideographs, emoji — is untouched, because a person's name is theirs.
 *
 * Module-private on purpose: it is not a sanitiser for general use, it is
 * what {@link commitAll} does to an identity on its way into a commit header.
 * A second caller would be a second policy. Tested through `commitAll`, which
 * is the path that matters.
 *
 * @param value - The name or address as it was configured.
 * @returns The same string with its control characters removed.
 */
function stripControlCharacters(value: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the entire purpose.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/**
 * Stage everything in the tree and commit it under `identity`.
 *
 * The identity is passed per command rather than written into the repo's
 * config, because who commits changes with who is asking — a merge is committed
 * as the agent that asked for it, a `ROOM.md` save as the person who typed it —
 * and a config value would make the LAST writer's name the default for the
 * next one.
 *
 * The identity's control characters are stripped on the way in
 * ({@link stripControlCharacters}) — a commit header DorkOS writes is parsed
 * again later, and a name carrying a field separator is a name that rewrites
 * somebody else's row.
 *
 * @param repoDir - The checkout to commit in.
 * @param message - The commit subject.
 * @param identity - Who the commit is attributed to.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns The new commit's full sha.
 */
export async function commitAll(
  repoDir: string,
  message: string,
  identity: GitIdentity,
  ceilingDir: string
): Promise<string> {
  await runGit(['add', '--all'], repoDir, ceilingDir);
  await runGit(
    [
      '-c',
      // Stripped, not trusted: see {@link stripControlCharacters} for the
      // parser this protects and the measurement behind it.
      `user.name=${stripControlCharacters(identity.name)}`,
      '-c',
      `user.email=${stripControlCharacters(identity.email)}`,
      'commit',
      // The second line, not the first: `core.hooksPath` above is what actually
      // stops a hook. See the module doc — this skips `pre-commit` and
      // `commit-msg` only, measured.
      '--no-verify',
      '--quiet',
      '-m',
      message,
    ],
    repoDir,
    ceilingDir
  );
  return runGit(['rev-parse', 'HEAD'], repoDir, ceilingDir);
}

/**
 * Whether a checkout holds changes that are not committed — staged, unstaged or
 * untracked alike.
 *
 * One `status --porcelain` rather than the workspace domain's richer dirty
 * state, because the question a room asks of a worktree is a yes/no: may this
 * be thrown away. What is dirty about it is the explorer's job to show, not the
 * delete guard's.
 *
 * @param checkoutDir - The checkout to inspect.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function hasUncommittedChanges(
  checkoutDir: string,
  ceilingDir: string
): Promise<boolean> {
  return (await runGit(['status', '--porcelain=v1'], checkoutDir, ceilingDir)).length > 0;
}

/**
 * How many commits `checkoutDir`'s HEAD holds that `main` does not.
 *
 * `0` means merged, and it means ONLY that: a repo with no `main` yet answers
 * `0` because a tree that cannot be compared against an integration branch that
 * does not exist has nothing stranded in it by definition, and that one case is
 * established by {@link hasMainBranch} rather than inferred from a failure.
 * Every other failure propagates, so the delete guard's conservative handler
 * sees it and calls the worktree unfinished.
 *
 * @param checkoutDir - The worktree to measure.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns The count of unmerged commits.
 * @throws When the checkout cannot be read.
 */
export async function commitsAheadOfMain(checkoutDir: string, ceilingDir: string): Promise<number> {
  if (!(await hasMainBranch(checkoutDir, ceilingDir))) return 0;
  const out = await runGit(['rev-list', '--count', 'main..HEAD'], checkoutDir, ceilingDir);
  return Number.parseInt(out, 10) || 0;
}

/**
 * Add a standing worktree at `worktreeDir` on branch `branch`.
 *
 * Two shapes, because the branch may already exist: the reap removes a
 * worktree's DIRECTORY and `git worktree remove` leaves the branch behind, so
 * "create the branch" is right the first time and wrong every time after. The
 * caller decides which with `createFrom`, having asked
 * {@link hasLocalBranch} — see {@link addWorktree}'s only caller for why that
 * probe is not replaced by catching the failure.
 *
 * @param repoDir - The room's main checkout, which owns the worktree list.
 * @param worktreeDir - Where the new working tree goes. Must not exist.
 * @param branch - The branch to check out in it.
 * @param createFrom - The commit-ish to branch FROM (`'main'`), or `null` to
 *   check out a branch that already exists.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function addWorktree(
  repoDir: string,
  worktreeDir: string,
  branch: string,
  createFrom: string | null,
  ceilingDir: string
): Promise<void> {
  const args = createFrom
    ? ['worktree', 'add', '--quiet', '-b', branch, worktreeDir, createFrom]
    : ['worktree', 'add', '--quiet', worktreeDir, branch];
  await runGit(args, repoDir, ceilingDir);
}

/**
 * Remove a standing worktree — **never forced**.
 *
 * The absent `--force` is the point. Git refuses to remove a working tree that
 * holds modified or untracked files, so this call is a second, independent
 * check on the reap's own dirty gate, made by git at the moment of deletion
 * rather than by DorkOS a few milliseconds earlier. An agent that started
 * writing between the two is protected by the one that runs last.
 *
 * @param repoDir - The room's main checkout.
 * @param worktreeDir - The working tree to remove.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @throws When git refuses, which includes "it is not empty".
 */
export async function removeWorktree(
  repoDir: string,
  worktreeDir: string,
  ceilingDir: string
): Promise<void> {
  await runGit(['worktree', 'remove', worktreeDir], repoDir, ceilingDir);
}

/**
 * Drop the administrative records of worktrees whose directories are gone.
 *
 * Run after a reap so `git worktree list` matches the disk. Harmless when
 * nothing was removed.
 *
 * @param repoDir - The room's main checkout.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function pruneWorktrees(repoDir: string, ceilingDir: string): Promise<void> {
  await runGit(['worktree', 'prune'], repoDir, ceilingDir);
}

/**
 * Delete a branch **only if `main` already contains it** (`-d`, never `-D`).
 *
 * The safe form is load-bearing rather than tidy: it means this call cannot be
 * the thing that loses a commit even if every check above it were wrong. Git
 * refuses and the branch stays.
 *
 * @param repoDir - The room's main checkout.
 * @param branch - The branch to retire.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns `true` when the branch is gone, `false` when git refused.
 */
export async function deleteMergedBranch(
  repoDir: string,
  branch: string,
  ceilingDir: string
): Promise<boolean> {
  try {
    await runGit(['branch', '--quiet', '-d', branch], repoDir, ceilingDir);
    return true;
  } catch (err) {
    if (err instanceof GitUnavailableError) throw err;
    return false;
  }
}

/**
 * When the commit at `HEAD` was committed.
 *
 * Committer date rather than author date: it moves when a commit is rebased or
 * amended in this tree, which is the question "when was this worktree last
 * worked in" actually asks.
 *
 * @param checkoutDir - The checkout to ask.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns The commit time, or `null` when there are no commits yet.
 */
export async function headCommittedAt(
  checkoutDir: string,
  ceilingDir: string
): Promise<Date | null> {
  const iso = await runGit(['log', '-1', '--format=%cI'], checkoutDir, ceilingDir);
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The absolute git directory backing a checkout.
 *
 * For a linked worktree this is `<repo>/.git/worktrees/<name>`, which is where
 * that worktree's own `index` lives — the file whose mtime says when anything
 * was last staged, committed or refreshed in it.
 *
 * @param checkoutDir - The checkout to ask.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function absoluteGitDir(checkoutDir: string, ceilingDir: string): Promise<string> {
  return runGit(['rev-parse', '--absolute-git-dir'], checkoutDir, ceilingDir);
}

/**
 * The git directory shared by a repo and every worktree of it.
 *
 * `info/exclude` lives here (git's `common_list` maps `info` to the common
 * directory), so one write covers the main checkout and every standing
 * worktree at once.
 *
 * @param checkoutDir - Any checkout of the repo.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function commonGitDir(checkoutDir: string, ceilingDir: string): Promise<string> {
  const dir = await runGit(['rev-parse', '--git-common-dir'], checkoutDir, ceilingDir);
  return path.resolve(checkoutDir, dir);
}
