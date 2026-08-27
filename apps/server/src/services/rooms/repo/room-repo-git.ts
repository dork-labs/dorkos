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
 * Run one git command in `cwd` and answer its trimmed stdout.
 *
 * @param args - Arguments after `git`, without the shared config prefix.
 * @param cwd - The directory to run in. Must exist.
 * @param ceilingDir - The room home directory git's repository search may not
 *   climb past. Required rather than defaulted: a caller that forgets it is a
 *   caller reading somebody else's repository, which is the bug this exists to
 *   prevent.
 * @returns Trimmed stdout.
 * @throws {GitUnavailableError} When there is no `git` on this machine.
 * @throws When git exits non-zero or the timeout elapses.
 */
export async function runGit(args: string[], cwd: string, ceilingDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...SHARED_CONFIG_ARGS, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(ceilingDir),
    });
    return stdout.trim();
  } catch (err) {
    // `ENOENT` from `execFile` is the BINARY, not a missing path: the cwd is
    // checked by the caller and a missing repo exits 128 with a message.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new GitUnavailableError(err);
    throw err;
  }
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
  try {
    await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], checkoutDir, ceilingDir);
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
 * Stage everything in the tree and commit it under `identity`.
 *
 * The identity is passed per command rather than written into the repo's
 * config, because who commits changes with who is asking — a merge is committed
 * as the agent that asked for it, a `ROOM.md` save as the person who typed it —
 * and a config value would make the LAST writer's name the default for the
 * next one.
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
      `user.name=${identity.name}`,
      '-c',
      `user.email=${identity.email}`,
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
