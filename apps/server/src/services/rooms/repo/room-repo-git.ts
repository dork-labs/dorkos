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
 * Every command goes through the private shared launchers; finite mutation helpers additionally require an original mutation context;
 * no public arbitrary-argv launcher exists. Each piece is here because it was
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
 * - **`-c core.fsmonitor=` (empty).** A repo-local `core.fsmonitor` is a command
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
 * - **A command run in an agent's worktree is pinned to the room's own git
 *   storage** (spec `agent-home-desk` §5.1, {@link worktreePin}). A worktree
 *   finds its repository through its `.git` file and the admin folder's
 *   `commondir`, and both are in folders its agent's turns may write. Left to
 *   discovery, a rewritten pointer would hand the server's `git status` a config
 *   the agent wrote — and a config can name programs git runs on a read (a
 *   filter driver, say). So `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` are
 *   set from the room's layout, and the only config git reads is `repo/.git`'s.
 * - **`repo/.git/config` is audited before every command that reads the room**
 *   ({@link assertRoomRepoConfigSafe}). No agent is GRANTED it, but a shell that
 *   is not sandboxed can write it — a plain `git config …` in an agent's copy
 *   lands there — so any key that names a program (a filter, a diff or merge
 *   driver, an include, an fsmonitor, a credential helper…) stops every server
 *   git command in the room with `ROOM_REPO_CONFIG_UNSAFE` until a person
 *   removes it. The server refuses to run anything that config defines.
 * - **`-c diff.ignoreSubmodules=all` (with `status.submoduleSummary=false` and
 *   `submodule.recurse=false`).** A submodule is a folder with its OWN git
 *   config, and an agent can commit a gitlink into its copy beside a `sub/`
 *   whose `.git/config` names a filter program; `git status` in the copy
 *   recursed into it and ran that program as the server (measured, with or
 *   without the pin above). Ignoring submodules stops the recursion; merges
 *   refuse submodules anyway.
 * - **No detached housekeeping** (`maintenance.autoDetach=false`,
 *   `gc.autoDetach=false`). Git's automatic maintenance still runs after a
 *   commit or merge, but in the foreground, so nothing keeps writing the room's
 *   `.git` after the server's call returns.
 * - **Drivers named by committed `.gitattributes` run nothing.** An agent
 *   writes `.gitattributes`, and a `filter`, `diff` or `merge` attribute names a
 *   driver — but a driver is only a program when a config git reads defines it.
 *   The configs the server's git reads are `repo/.git/config` (audited above)
 *   and nothing else: global and system config are `/dev/null`, and a
 *   copy's `config.worktree` is read only when `repo/.git/config` turns worktree
 *   config on, which it never does. Pinned against real git in
 *   `__tests__/room-turn-place.test.ts`, merge included.
 *
 * **What none of this claims:** a repo-local `.git/hooks/` directory that some
 * other program populated is neutralised by `core.hooksPath`, but nothing here
 * inspects a checkout for hostile content. A shell that is not sandboxed can
 * still write anywhere, `repo/.git/config` included; what it writes there is
 * refused, never run. What this module contributes to a
 * SAFE merge is the four reads the policy is made of — {@link aheadBehind},
 * {@link listTree}, {@link readBlob} and {@link shortstat} — plus
 * {@link mergeNoFf}, which is the one command in the domain that can leave a
 * checkout mid-merge and therefore owns the abort. The policy itself (which
 * refusal, which cap, whose branch) lives in `room-merge-service.ts`.
 *
 * **There is no force, no reset and no push anywhere in this module**, and that
 * absence is load-bearing rather than an omission: history in a room's repo is
 * append-only (spec §3.6), so the destructive verbs are not exposed at a lower
 * layer for a higher one to decline to call. `deleteMergedBranch` is `-d` and
 * `removeWorktree` has no `--force`, for the same reason.
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
import { promises as fsp } from 'node:fs';
import { internalGitArgs } from '../../../lib/git-safety.js';
import { RoomRepoConfigUnsafeError } from '../data/room-errors.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';

import { createOriginalRoomGitObservationsFamily } from './git/room-repo-git-observations.js';
import { createOriginalRoomGitCheckoutFamily } from './git/room-repo-git-checkout.js';
import { createOriginalRoomGitWorktreeFamily } from './git/room-repo-git-worktree.js';
import { createOriginalRoomGitHistoryFamily } from './git/room-repo-git-history.js';

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
 * How much stdout a command whose output scales with the repository may write.
 *
 * `execFile` defaults to 1 MB and KILLS the child past it, so `ls-tree -r` — one
 * line per file in the tree — fails somewhere around fifteen to twenty thousand
 * files. That failure carries no code a caller could branch on, so it surfaced
 * as an unmapped 500 on a merge that was merely large. Sixty-four megabytes is
 * roughly a million paths, well past any room repo and still a bound.
 */
const LARGE_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Config overrides applied to EVERY command, ahead of the subcommand.
 *
 * `-c` rather than writing them into the repo's own config, because the repo's
 * config is a file member-written content can reach and these are exactly the
 * values that turn reading a checkout into running code: the shared set every
 * git command DorkOS runs carries (`internalGitArgs`, DOR-2326), which also
 * refuses a bare repository git merely finds. See the module doc for what
 * the hook and fsmonitor settings were measured to stop.
 */
const SHARED_CONFIG_ARGS = [
  ...internalGitArgs(),
  // **Never look inside a submodule.** An agent can commit a gitlink into its
  // copy beside a `sub/` holding its own `.git/config` — a folder the agent
  // wrote, whose filter, textconv or fsmonitor program a status read would run
  // as the server when git recursed into it. `diff.ignoreSubmodules=all` is what
  // stops that recursion for `status` and `diff` (measured: `submodule.recurse`
  // alone does not). Submodules are refused at merge anyway
  // (`SUBMODULE_NOT_ALLOWED`), so nothing a room keeps depends on them.
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'status.submoduleSummary=false',
  '-c',
  'submodule.recurse=false',
  // **Housekeeping runs INSIDE the call, never after it.** A commit or merge
  // ends by running git's automatic maintenance, which by default detaches into
  // the background and keeps writing `repo/.git` (a `gc`, a `maintenance.lock`)
  // after the server's pinned, audited command has returned — racing the next
  // command and the turn-start refresh. Kept rather than turned off, so a
  // room's objects are still packed; just in the foreground, where it finishes
  // before the call does.
  '-c',
  'maintenance.autoDetach=false',
  '-c',
  'gc.autoDetach=false',
];

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

/**
 * Raised when git cannot read a path AS a path.
 *
 * Its own type for the reason {@link GitUnavailableError} has one: it is not a
 * failure of the repository or of the request as a whole, it is a statement
 * about one argument — and the caller's answer to it ("that path is not one
 * this room can have") is nothing like its answer to a git that fell over.
 */
export class UnreadablePathError extends Error {
  constructor(
    readonly path: string,
    cause?: unknown
  ) {
    super(`git cannot read ${path} as a file name`);
    this.name = 'UnreadablePathError';
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
 * The characters git calls "crud" in an author name — `crud()` in git's own
 * `ident.c`, copied exactly.
 *
 * git refuses a name made of nothing else ("fatal: name consists only of
 * disallowed characters"), measured with `<>`, `"` and a lone space. A `.` is
 * NOT on the list, which is why `...` commits and `"` does not.
 *
 * @param char - One character of the name.
 */
function isGitNameCrud(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 32 || ',:;<>"\\\''.includes(char);
}

/**
 * The name a commit made on a PERSON's behalf is authored under — theirs when
 * git will take it, {@link FALLBACK_OPERATOR_GIT_NAME} when it will not.
 *
 * A display name is text the person chose, and git refuses some of it outright:
 * a name that is empty, or made only of `<`, `>`, quotes, commas and the like,
 * fails the COMMIT, after the file has already been written. That is a save a
 * person cannot make for a reason that has nothing to do with the file, so the
 * name falls back rather than the save failing — the same fallback an install
 * with no name for its operator has always used. The room entry, not git, is
 * where a person's name is read back from (spec `agent-home-desk` §7.1), so the
 * fallback costs nothing a reader relies on.
 *
 * Control characters, `<` and `>` are removed first: git strips the angle
 * brackets itself and {@link commitStaged} strips control characters, so what is
 * judged here is exactly what would reach the commit header.
 *
 * @param name - The person's display name, or `null` when there is none.
 * @returns A name git will accept.
 */
export function gitAuthorName(name: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex -- control characters are what a commit header must not carry.
  const cleaned = (name ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '');
  for (const char of cleaned) {
    if (!isGitNameCrud(char)) return cleaned;
  }
  return FALLBACK_OPERATOR_GIT_NAME;
}

/**
 * The address a person's commit carries: `person-<authorId>@dorkos.local`.
 *
 * Stable, and deliberately not an address anybody has: a `.local` domain can
 * never resolve (RFC 6762), so no real email lands in a room's history, while
 * two people still get two authors in `git log`. The author id is an opaque
 * room-domain id; anything but letters, digits, `-` and `_` is dropped so the
 * header cannot be bent by it.
 *
 * @param authorId - The person's room author id.
 */
export function personGitEmail(authorId: string): string {
  return `person-${authorId.replace(/[^A-Za-z0-9_-]/g, '')}@dorkos.local`;
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
function gitEnv(ceilingDir: string, cwd: string): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-restricted-syntax -- git must inherit PATH/HOME; this REMOVES the redirecting vars and adds the confinement, which is only expressible against the real environment.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REDIRECTING_GIT_VARS) delete env[name];
  return {
    ...env,
    // Set from the room's layout — never read from a pointer the agent can
    // write — when the command runs in one of the room's worktrees.
    ...worktreePin(ceilingDir, cwd),
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
 * The git storage a command run in `<room home>/worktrees/<name>` (or below it)
 * must use: `repo/.git` as the common directory, its `worktrees/<name>` admin
 * folder as the git directory, and the worktree as the work tree. Empty for
 * every other directory, which discovers its repository as before.
 *
 * Computed from the path alone. A worktree whose admin folder has another name
 * (git suffixes one when the name is taken) fails as "not a git repository",
 * which every caller reads as unreadable — work that is spared, never deleted.
 *
 * @param ceilingDir - The room's home directory.
 * @param cwd - Where the command runs.
 */
function worktreePin(ceilingDir: string, cwd: string): Record<string, string> {
  const rel = path.relative(path.resolve(ceilingDir), path.resolve(cwd));
  const [top, name] = rel.split(path.sep);
  if (top !== 'worktrees' || !name || name === '..' || path.isAbsolute(rel)) return {};
  const commonDir = path.join(path.resolve(ceilingDir), 'repo', '.git');
  return {
    GIT_COMMON_DIR: commonDir,
    GIT_DIR: path.join(commonDir, 'worktrees', name),
    GIT_WORK_TREE: path.join(path.resolve(ceilingDir), 'worktrees', name),
  };
}

/**
 * Config keys that make git run a program, or send it somewhere else, when the
 * server's own git reads the room's repository. Matched case-insensitively on
 * the key as `git config --list` prints it.
 *
 * - `filter.*` — clean/smudge/process programs, run on status, add, checkout
 *   and merge for any path a committed `.gitattributes` names;
 * - `diff.external`, `diff.<x>.textconv|command`, `merge.<x>.driver` — the
 *   same for diffs and merges;
 * - `include.*`, `includeIf.*` — pull in a config file from anywhere;
 * - `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, `core.askPass`,
 *   `core.gitProxy`, `core.alternateRefsCommand`, `sequence.editor`,
 *   `credential.*`, `gpg.*`, `commit.gpgSign`, `tag.gpgSign` — programs git
 *   runs for a read, a commit, a merge or a credential (hooks and fsmonitor are
 *   overridden on every call too; their presence here is still a tamper sign);
 * - `core.worktree` — redirects where a command writes;
 * - `extensions.worktreeConfig` — would make each copy's own, agent-writable
 *   `config.worktree` part of what git reads;
 * - `uploadpack.*`, `receivepack.*`, `protocol.*`, `url.*` — transport
 *   behaviour a room never needs, refused rather than reasoned about.
 */
const UNSAFE_ROOM_CONFIG_KEY =
  /^(?:filter\.|include\.|includeif\.|credential\.|gpg\.|uploadpack\.|receivepack\.|protocol\.|url\.|diff\.external$|diff\.[^.]+\.(?:textconv|command)$|merge\.[^.]+\.driver$|core\.(?:fsmonitor|hookspath|sshcommand|askpass|gitproxy|alternaterefscommand|worktree)$|sequence\.editor$|commit\.gpgsign$|tag\.gpgsign$|extensions\.worktreeconfig$)/i;

/** The last config file a check passed, keyed by path, with the stat it passed at. */
const safeConfigSeen = new Map<string, string>();

/** Whether a command run in `cwd` reads the room's repository under `ceilingDir`. */
function readsRoomRepo(ceilingDir: string, cwd: string): boolean {
  const rel = path.relative(path.resolve(ceilingDir), path.resolve(cwd));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const top = rel.split(path.sep)[0];
  return top === 'repo' || top === 'worktrees';
}

/** The unsafe key names one settings file declares, read without following includes. */
async function unsafeKeysIn(
  file: string,
  ceilingDir: string,
  context?: InstallationRoomMutationContext
): Promise<string[]> {
  let listing: string;
  const args = ['config', '--file', file, '--no-includes', '--name-only', '--list'];
  const options = {
    cwd: path.dirname(file),
    timeout: GIT_TIMEOUT_MS,
    env: gitEnv(ceilingDir, ceilingDir),
  };
  if (context) await checkInstallationRoomMutationTarget(context, file);
  if (context) requireInstallationRoomMutationTarget(context, file);
  try {
    const { stdout } = await execFileAsync('git', args, options);
    listing = stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new GitUnavailableError(err);
    throw new RoomRepoConfigUnsafeError(file, []);
  }
  return [
    ...new Set(
      listing
        .split('\n')
        .map((key) => key.trim())
        .filter((key) => key !== '' && UNSAFE_ROOM_CONFIG_KEY.test(key))
    ),
  ];
}

/**
 * Refuse to let the server's git touch a room whose shared config names a
 * program (spec `agent-home-desk` §5.2, the T4 review).
 *
 * No agent is GRANTED `repo/.git/config`, but a shell that is not sandboxed
 * can write it — a plain `git config …` run in an agent's copy lands there —
 * and a `filter.x.smudge` defined in it runs as the server on the next merge,
 * checkout or status for any path a member's `.gitattributes` names. `-c` can
 * neutralise a key only when its name is known in advance, and a filter or
 * driver name is the author's choice, so the config is audited instead: every
 * key matching {@link UNSAFE_ROOM_CONFIG_KEY} stops every server git command in
 * the room with `ROOM_REPO_CONFIG_UNSAFE`, naming the keys, until a person
 * removes them.
 *
 * What git would READ is covered, not just the one file: an `include.path` or
 * `includeIf.*.path` is refused outright rather than followed, so nothing an
 * included file says is ever read; and `extensions.worktreeConfig` is refused,
 * so no copy's `repo/.git/worktrees/<slug>/config.worktree` is read either. An
 * agent is granted that folder and may write the file, but while the extension
 * is off git never opens it — so an inert file is left alone rather than
 * allowed to lock the room. Git's global and system settings are the
 * operator's own.
 *
 * Cached by the config file's size and times, so a room whose config has not
 * changed costs one `stat` per git command.
 *
 * Exported so a caller that is about to run a command which can execute
 * drivers — a merge, a fast-forward — can ask first and fail before it starts.
 *
 * @param ceilingDir - The room's home directory (`<room>/repo/.git` is read).
 * @throws {RoomError} `ROOM_REPO_CONFIG_UNSAFE` naming the offending keys.
 */
export async function assertRoomRepoConfigSafe(ceilingDir: string): Promise<void> {
  return checkRoomRepoConfigSafe(ceilingDir);
}

async function checkRoomRepoConfigSafe(
  ceilingDir: string,
  context?: InstallationRoomMutationContext
): Promise<void> {
  const file = path.join(path.resolve(ceilingDir), 'repo', '.git', 'config');
  let stamp: string;
  try {
    const stat = await fsp.stat(file);
    stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return; // No repository yet (or none here): nothing configures anything.
  }
  if (safeConfigSeen.get(file) === stamp) return;
  const unsafe = await unsafeKeysIn(file, ceilingDir, context);
  if (unsafe.length > 0) {
    safeConfigSeen.delete(file);
    throw new RoomRepoConfigUnsafeError(file, unsafe);
  }
  safeConfigSeen.set(file, stamp);
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
  /**
   * How long the command may run before it is killed, defaulting to
   * {@link GIT_TIMEOUT_MS}. A caller whose command WRITES a working tree whose
   * size it does not control (the turn-start fast-forward) passes a longer one,
   * because killing a write halfway leaves the tree halfway.
   */
  timeoutMs?: number;
}

/** Arbitrary argv are private; only fixed operation constructors below may launch them. */
export interface NativeLaunch {
  started: boolean;
}

/** Private owned launcher; extra targets come only from finite mutation helpers. */
import { requireOriginalRoomWorktreeReapEffect } from './room-worktree-manager.js';

async function runOwnedGitRaw(
  args: string[],
  cwd: string,
  ceilingDir: string,
  context: InstallationRoomMutationContext,
  options: RunGitOptions = {},
  extraTargets: readonly string[] = [],
  launch?: NativeLaunch
): Promise<Buffer> {
  const roots = readInstallationRoomMutationRoots(context);
  if (
    !path.isAbsolute(cwd) ||
    !path.isAbsolute(ceilingDir) ||
    path.resolve(ceilingDir) !== roots.homePath
  ) {
    throw new Error('Git ceiling must be the captured room home.');
  }
  const targets = [cwd, ...extraTargets];
  for (const target of targets) await checkInstallationRoomMutationTarget(context, target);
  if (readsRoomRepo(ceilingDir, cwd)) await checkRoomRepoConfigSafe(ceilingDir, context);
  // Construct all caller-controlled arguments/options before the decisive guards.
  const command = [...SHARED_CONFIG_ARGS, ...args];
  const childOptions = {
    cwd,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    env: gitEnv(ceilingDir, cwd),
    maxBuffer: options.maxBuffer ?? GIT_MAX_OUTPUT_BYTES,
    encoding: 'buffer' as const,
  };
  for (const target of targets) await checkInstallationRoomMutationTarget(context, target);
  for (const target of targets) requireInstallationRoomMutationTarget(context, target);
  requireOriginalRoomWorktreeReapEffect(context);
  if (launch) launch.started = true;
  // No await or supplied callback between the final fixed guards and launch.
  try {
    const { stdout } = await execFileAsync('git', command, childOptions);
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new GitUnavailableError(error);
    throw error;
  }
}

async function runOwnedGit(
  args: string[],
  cwd: string,
  ceilingDir: string,
  context: InstallationRoomMutationContext,
  options: RunGitOptions = {},
  extraTargets: readonly string[] = [],
  launch?: NativeLaunch
): Promise<string> {
  return (await runOwnedGitRaw(args, cwd, ceilingDir, context, options, extraTargets, launch))
    .toString('utf-8')
    .trim();
}

/** Private finite-read implementation. It is never exported as an arbitrary-args alias. */
async function runReadGitRaw(
  args: string[],
  cwd: string,
  ceilingDir: string,
  options: RunGitOptions = {}
): Promise<Buffer> {
  if (readsRoomRepo(ceilingDir, cwd)) await assertRoomRepoConfigSafe(ceilingDir);
  try {
    const { stdout } = await execFileAsync('git', [...SHARED_CONFIG_ARGS, ...args], {
      cwd,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      env: { ...gitEnv(ceilingDir, cwd), GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: options.maxBuffer ?? GIT_MAX_OUTPUT_BYTES,
      encoding: 'buffer',
    });
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new GitUnavailableError(error);
    throw error;
  }
}

async function runReadGit(
  args: string[],
  cwd: string,
  ceilingDir: string,
  options: RunGitOptions = {}
): Promise<string> {
  return (await runReadGitRaw(args, cwd, ceilingDir, options)).toString('utf-8').trim();
}

/** Revision operands must remain operands, never additional log/diff output options. */
function requireRevisionOperand(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('-') ||
    value.includes('\0')
  ) {
    throw new Error('Expected a Git revision operand, not a command option.');
  }
}

/** Resolve a literal pathspec before it can reach a mutation command. */
function requireRepoRelativeMutationPath(repoDir: string, value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    path.isAbsolute(value)
  )
    throw new Error('Expected a repository-relative mutation path.');
  const target = path.resolve(repoDir, value);
  const relative = path.relative(path.resolve(repoDir), target);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.split(path.sep)[0] === '.git'
  )
    throw new Error('Mutation path escapes the captured repository content.');
  return target;
}

/** Recognize the same ASCII control range without a control-character regexp. */
function roomFilePathHasControlCode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A normalized literal room-reader path, already normalized by the owning caller. */
function requireRoomFileLiteralPath(repoDir: string, value: string): void {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    value !== value.trim() ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value) ||
    roomFilePathHasControlCode(value)
  )
    throw new Error('Expected a normalized room-file literal path.');
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || part !== part.trim())
      throw new Error('Expected a normalized room-file literal path.');
  }
  requireRepoRelativeMutationPath(repoDir, value);
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

/** What a working tree holds that its last commit does not. */
export interface StrayChange {
  /** The path, relative to the checkout root. */
  path: string;
  /** What happened to it, as a person would say it. */
  kind: 'added' | 'modified' | 'deleted' | 'untracked';
  /**
   * Where this file was before somebody renamed it, when that is what happened.
   *
   * **Carried, rather than dropped, because undoing a rename needs both
   * halves.** A rename is one act and two paths: the new name appears and the
   * old one vanishes. Whoever undoes it has to put the old name back as well as
   * take the new one away — a discard that knew only the new path deleted the
   * file from the room and left the old name still missing, which is a
   * destructive half-completion of an act the operator asked to UNDO (found in
   * review, reproduced with `git mv`).
   *
   * The old path is deliberately still not a stray of its own: offering it as a
   * separate thing to discard would offer a path that is not there.
   */
  renamedFrom?: string;
}

/**
 * What a porcelain status pair means, in a word a person reads.
 *
 * Deliberately coarser than git's own vocabulary: the person is being asked
 * whether to keep or discard a change, and "staged for deletion but modified in
 * the tree" is not a distinction that changes that answer.
 *
 * @param index - The index status letter.
 * @param worktree - The working-tree status letter.
 */
function strayKind(index: string, worktree: string): StrayChange['kind'] {
  if (index === '?' || worktree === '?') return 'untracked';
  if (index === 'D' || worktree === 'D') return 'deleted';
  if (index === 'A') return 'added';
  return 'modified';
}

/** One entry in a tree, as `git ls-tree -r -l` describes it. */
export interface TreeEntry {
  /** The path, relative to the repo root, with `/` separators. */
  path: string;
  /**
   * The git file mode — `100644`, `100755`, `120000` for a symlink, or
   * `160000` for a gitlink (a submodule).
   */
  mode: string;
  /** The object id. */
  sha: string;
  /**
   * The blob's size in bytes. For a symlink, the length of its target; for a
   * gitlink, `0`, because there is no object in this repository to measure.
   */
  size: number;
}

/** The mode git gives a symlink. */
export const SYMLINK_MODE = '120000';

/**
 * The mode git gives a **gitlink** — the pointer a submodule leaves in a tree.
 *
 * Named here because a caller has to be able to REFUSE it, and because it is
 * the entry that does not behave like the others: it names a commit in a
 * repository that is not this one, so there is nothing to size, nothing to read,
 * and nothing this validation could inspect.
 */
export const GITLINK_MODE = '160000';

/** What one merge would bring in, as a person reads it. */
export interface DiffStat {
  /** How many files the delta touches, additions and deletions included. */
  files: number;
  /** Lines added. */
  insertions: number;
  /** Lines removed. */
  deletions: number;
}

/**
 * Raised when a merge could not be completed and was rolled back.
 *
 * Its own type because it is the one git failure a caller must be able to tell
 * from every other: the tree is exactly as it was, so the right answer is a
 * refusal the agent can act on rather than an error report.
 */
export class MergeConflictError extends Error {
  constructor(
    /** The branch that would not merge. */
    readonly branch: string,
    cause?: unknown
  ) {
    super(`Could not merge ${branch} cleanly`);
    this.name = 'MergeConflictError';
    this.cause = cause;
  }
}

/** Fixed original private Git command ports, readable only with the module-owned key. */
export interface OriginalRoomGitCommandPorts {
  runOwnedGit: typeof runOwnedGit;
  runReadGitRaw: typeof runReadGitRaw;
  runReadGit: typeof runReadGit;
  requireRevisionOperand: typeof requireRevisionOperand;
  requireRepoRelativeMutationPath: typeof requireRepoRelativeMutationPath;
  requireRoomFileLiteralPath: typeof requireRoomFileLiteralPath;
  stripControlCharacters: typeof stripControlCharacters;
  strayKind: typeof strayKind;
  LARGE_OUTPUT_MAX_BUFFER: number;
}
const originalRoomGitCommandPorts = new WeakMap<object, OriginalRoomGitCommandPorts>();
const roomGitMapGet = WeakMap.prototype.get;
const roomGitMapSet = WeakMap.prototype.set;
const roomGitApply = Reflect.apply;
const roomGitFreeze = Object.freeze;
const originalRoomGitCommandKey = roomGitFreeze({});

/** Reject every caller that does not hold the original module-private command key. */
export function readOriginalRoomGitCommandPorts(owner: object): OriginalRoomGitCommandPorts {
  const ports = roomGitApply(roomGitMapGet, originalRoomGitCommandPorts, [owner]);
  if (!ports) throw new Error('Original Room Git command owner required.');
  return ports;
}
roomGitApply(roomGitMapSet, originalRoomGitCommandPorts, [
  originalRoomGitCommandKey,
  roomGitFreeze({
    runOwnedGit,
    runReadGitRaw,
    runReadGit,
    requireRevisionOperand,
    requireRepoRelativeMutationPath,
    requireRoomFileLiteralPath,
    stripControlCharacters,
    strayKind,
    LARGE_OUTPUT_MAX_BUFFER,
  }),
]);

const originalObservations = createOriginalRoomGitObservationsFamily(originalRoomGitCommandKey);
/** Original finite readRoomForegroundMaintenance operation, retaining its private native launcher. */
export const readRoomForegroundMaintenance: typeof originalObservations.readRoomForegroundMaintenance =
  originalObservations.readRoomForegroundMaintenance;
/** Original finite readRoomWorkingDiff operation, retaining its private native launcher. */
export const readRoomWorkingDiff: typeof originalObservations.readRoomWorkingDiff =
  originalObservations.readRoomWorkingDiff;
/** Original finite readRoomWorktreeRegistration operation, retaining its private native launcher. */
export const readRoomWorktreeRegistration: typeof originalObservations.readRoomWorktreeRegistration =
  originalObservations.readRoomWorktreeRegistration;
/** Original finite fastForwardRoomWorktree operation, retaining its private native launcher. */
export const fastForwardRoomWorktree: typeof originalObservations.fastForwardRoomWorktree =
  originalObservations.fastForwardRoomWorktree;
/** Original finite roomStatusRaw operation, retaining its private native launcher. */
export const roomStatusRaw: typeof originalObservations.roomStatusRaw =
  originalObservations.roomStatusRaw;
/** Original finite roomTrackedPathsRaw operation, retaining its private native launcher. */
export const roomTrackedPathsRaw: typeof originalObservations.roomTrackedPathsRaw =
  originalObservations.roomTrackedPathsRaw;
/** Original finite roomHiddenUntrackedRaw operation, retaining its private native launcher. */
export const roomHiddenUntrackedRaw: typeof originalObservations.roomHiddenUntrackedRaw =
  originalObservations.roomHiddenUntrackedRaw;
/** Original finite roomVerifiedTip operation, retaining its private native launcher. */
export const roomVerifiedTip: typeof originalObservations.roomVerifiedTip =
  originalObservations.roomVerifiedTip;
/** Original finite roomSymbolicHead operation, retaining its private native launcher. */
export const roomSymbolicHead: typeof originalObservations.roomSymbolicHead =
  originalObservations.roomSymbolicHead;
/** Original finite roomCommitCount operation, retaining its private native launcher. */
export const roomCommitCount: typeof originalObservations.roomCommitCount =
  originalObservations.roomCommitCount;
/** Original finite roomChangedPathsRaw operation, retaining its private native launcher. */
export const roomChangedPathsRaw: typeof originalObservations.roomChangedPathsRaw =
  originalObservations.roomChangedPathsRaw;
/** Original finite roomMergeBase operation, retaining its private native launcher. */
export const roomMergeBase: typeof originalObservations.roomMergeBase =
  originalObservations.roomMergeBase;
/** Original finite roomLogRaw operation, retaining its private native launcher. */
export const roomLogRaw: typeof originalObservations.roomLogRaw = originalObservations.roomLogRaw;
/** Original finite roomBlobSize operation, retaining its private native launcher. */
export const roomBlobSize: typeof originalObservations.roomBlobSize =
  originalObservations.roomBlobSize;
/** Original finite roomShowObject operation, retaining its private native launcher. */
export const roomShowObject: typeof originalObservations.roomShowObject =
  originalObservations.roomShowObject;
/** Original finite readRoomFileTreeRaw operation, retaining its private native launcher. */
export const readRoomFileTreeRaw: typeof originalObservations.readRoomFileTreeRaw =
  originalObservations.readRoomFileTreeRaw;
/** Original finite readRoomFileContentRaw operation, retaining its private native launcher. */
export const readRoomFileContentRaw: typeof originalObservations.readRoomFileContentRaw =
  originalObservations.readRoomFileContentRaw;
/** Original finite readRoomFileProvenanceRaw operation, retaining its private native launcher. */
export const readRoomFileProvenanceRaw: typeof originalObservations.readRoomFileProvenanceRaw =
  originalObservations.readRoomFileProvenanceRaw;
/** Original finite readRoomFileBlobRaw operation, retaining its private native launcher. */
export const readRoomFileBlobRaw: typeof originalObservations.readRoomFileBlobRaw =
  originalObservations.readRoomFileBlobRaw;
/** Original finite readRoomFileCommitRaw operation, retaining its private native launcher. */
export const readRoomFileCommitRaw: typeof originalObservations.readRoomFileCommitRaw =
  originalObservations.readRoomFileCommitRaw;

const originalCheckout = createOriginalRoomGitCheckoutFamily(originalRoomGitCommandKey);
/** Original finite initRepo operation, retaining its private native launcher. */
export const initRepo: typeof originalCheckout.initRepo = originalCheckout.initRepo;
/** Original finite hasMainBranch operation, retaining its private native launcher. */
export const hasMainBranch: typeof originalCheckout.hasMainBranch = originalCheckout.hasMainBranch;
/** Original finite hasLocalBranch operation, retaining its private native launcher. */
export const hasLocalBranch: typeof originalCheckout.hasLocalBranch =
  originalCheckout.hasLocalBranch;
/** Original finite commitAll operation, retaining its private native launcher. */
export const commitAll: typeof originalCheckout.commitAll = originalCheckout.commitAll;
/** Original finite stagePaths operation, retaining its private native launcher. */
export const stagePaths: typeof originalCheckout.stagePaths = originalCheckout.stagePaths;
/** Original finite hasStagedChanges operation, retaining its private native launcher. */
export const hasStagedChanges: typeof originalCheckout.hasStagedChanges =
  originalCheckout.hasStagedChanges;
/** Original finite commitStaged operation, retaining its private native launcher. */
export const commitStaged: typeof originalCheckout.commitStaged = originalCheckout.commitStaged;
/** Original finite listStrayChanges operation, retaining its private native launcher. */
export const listStrayChanges: typeof originalCheckout.listStrayChanges =
  originalCheckout.listStrayChanges;
/** Original finite isIgnored operation, retaining its private native launcher. */
export const isIgnored: typeof originalCheckout.isIgnored = originalCheckout.isIgnored;
/** Original finite pathsInHead operation, retaining its private native launcher. */
export const pathsInHead: typeof originalCheckout.pathsInHead = originalCheckout.pathsInHead;
/** Original finite restoreFromHead operation, retaining its private native launcher. */
export const restoreFromHead: typeof originalCheckout.restoreFromHead =
  originalCheckout.restoreFromHead;
/** Original finite unstagePaths operation, retaining its private native launcher. */
export const unstagePaths: typeof originalCheckout.unstagePaths = originalCheckout.unstagePaths;
/** Original finite hasUncommittedChanges operation, retaining its private native launcher. */
export const hasUncommittedChanges: typeof originalCheckout.hasUncommittedChanges =
  originalCheckout.hasUncommittedChanges;
/** Original finite commitsAheadOfMain operation, retaining its private native launcher. */
export const commitsAheadOfMain: typeof originalCheckout.commitsAheadOfMain =
  originalCheckout.commitsAheadOfMain;

const originalWorktree = createOriginalRoomGitWorktreeFamily(originalRoomGitCommandKey);
/** Original finite addWorktree operation, retaining its private native launcher. */
export const addWorktree: typeof originalWorktree.addWorktree = originalWorktree.addWorktree;
/** Original finite removeWorktree operation, retaining its private native launcher. */
export const removeWorktree: typeof originalWorktree.removeWorktree =
  originalWorktree.removeWorktree;
/** Original finite pruneWorktrees operation, retaining its private native launcher. */
export const pruneWorktrees: typeof originalWorktree.pruneWorktrees =
  originalWorktree.pruneWorktrees;
/** Original finite deleteMergedBranch operation, retaining its private native launcher. */
export const deleteMergedBranch: typeof originalWorktree.deleteMergedBranch =
  originalWorktree.deleteMergedBranch;

const originalHistory = createOriginalRoomGitHistoryFamily(originalRoomGitCommandKey);
/** Original finite headCommittedAt operation, retaining its private native launcher. */
export const headCommittedAt: typeof originalHistory.headCommittedAt =
  originalHistory.headCommittedAt;
/** Original finite aheadBehind operation, retaining its private native launcher. */
export const aheadBehind: typeof originalHistory.aheadBehind = originalHistory.aheadBehind;
/** Original finite listTree operation, retaining its private native launcher. */
export const listTree: typeof originalHistory.listTree = originalHistory.listTree;
/** Original finite readBlob operation, retaining its private native launcher. */
export const readBlob: typeof originalHistory.readBlob = originalHistory.readBlob;
/** Original finite shortstat operation, retaining its private native launcher. */
export const shortstat: typeof originalHistory.shortstat = originalHistory.shortstat;
/** Original finite revParse operation, retaining its private native launcher. */
export const revParse: typeof originalHistory.revParse = originalHistory.revParse;
/** Original finite currentBranch operation, retaining its private native launcher. */
export const currentBranch: typeof originalHistory.currentBranch = originalHistory.currentBranch;
/** Original finite mergeNoFf operation, retaining its private native launcher. */
export const mergeNoFf: typeof originalHistory.mergeNoFf = originalHistory.mergeNoFf;
/** Original finite absoluteGitDir operation, retaining its private native launcher. */
export const absoluteGitDir: typeof originalHistory.absoluteGitDir = originalHistory.absoluteGitDir;
/** Original finite commonGitDir operation, retaining its private native launcher. */
export const commonGitDir: typeof originalHistory.commonGitDir = originalHistory.commonGitDir;
