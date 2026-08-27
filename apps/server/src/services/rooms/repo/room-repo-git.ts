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
 * **Two hardening flags, and both are about a room's repo never running code
 * this machine's owner did not ask for** (spec §3.11 — the repo distributes
 * data, nothing in it executes at sync or merge time):
 *
 * - `-c init.templateDir=` on `init`, so the machine's global git template
 *   cannot seed the new repo with hooks. Without it, `git init` copies whatever
 *   `~/.config/git/templates/hooks/` holds into every room repo on the install.
 * - `--no-verify` on `commit`, so a hook that arrived some other way is not the
 *   thing that decides whether the server's own commit lands.
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

/** Who a commit is attributed to. */
export interface GitIdentity {
  /** The name `git log` shows. */
  name: string;
  /** The address beside it. */
  email: string;
}

/**
 * Run one git command in `cwd` and answer its trimmed stdout.
 *
 * @param args - Arguments after `git`.
 * @param cwd - The directory to run in. Must exist.
 * @returns Trimmed stdout.
 * @throws When git exits non-zero or the timeout elapses.
 */
export async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

/**
 * Create an empty repo whose default branch is `main`, with no hooks in it.
 *
 * `-b main` rather than a rename afterwards, so the branch is right before the
 * first commit exists and the sidecar's `defaultBranch: 'main'` is a statement
 * of fact rather than a hope.
 *
 * @param repoDir - The directory to initialise. Created by the caller.
 */
export async function initRepo(repoDir: string): Promise<void> {
  await runGit(['-c', 'init.templateDir=', 'init', '-b', 'main', '--quiet', '.'], repoDir);
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
 * @returns The new commit's full sha.
 */
export async function commitAll(
  repoDir: string,
  message: string,
  identity: GitIdentity
): Promise<string> {
  await runGit(['add', '--all'], repoDir);
  await runGit(
    [
      '-c',
      `user.name=${identity.name}`,
      '-c',
      `user.email=${identity.email}`,
      'commit',
      '--no-verify',
      '--quiet',
      '-m',
      message,
    ],
    repoDir
  );
  return runGit(['rev-parse', 'HEAD'], repoDir);
}

/**
 * Whether a checkout holds changes that are not committed — staged, unstaged or
 * untracked alike.
 *
 * One `status --porcelain` rather than the workspace domain's richer
 * {@link DirtyState}, because the question a room asks of a worktree is a
 * yes/no: may this be thrown away. What is dirty about it is the explorer's job
 * to show, not the delete guard's.
 *
 * @param checkoutDir - The checkout to inspect.
 */
export async function hasUncommittedChanges(checkoutDir: string): Promise<boolean> {
  return (await runGit(['status', '--porcelain=v1'], checkoutDir)).length > 0;
}

/**
 * How many commits `checkoutDir`'s HEAD holds that `main` does not.
 *
 * `0` when the branch is fully merged, and `0` for a repo with no `main` yet —
 * a tree that cannot be compared against an integration branch that does not
 * exist has nothing stranded in it by definition.
 *
 * @param checkoutDir - The worktree to measure.
 * @returns The count of unmerged commits.
 */
export async function commitsAheadOfMain(checkoutDir: string): Promise<number> {
  try {
    const out = await runGit(['rev-list', '--count', 'main..HEAD'], checkoutDir);
    return Number.parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}
