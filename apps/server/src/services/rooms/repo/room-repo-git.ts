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
import { RoomError, RoomRepoConfigUnsafeError } from '../data/room-errors.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';

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
interface NativeLaunch {
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

/** Observe the effective foreground maintenance settings through the same hardened read launcher. */
export async function readRoomForegroundMaintenance(
  checkoutDir: string,
  ceilingDir: string
): Promise<Readonly<{ maintenanceAutoDetach: string; gcAutoDetach: string }>> {
  const maintenanceAutoDetach = await runReadGit(
    ['config', '--get', 'maintenance.autoDetach'],
    checkoutDir,
    ceilingDir
  );
  const gcAutoDetach = await runReadGit(
    ['config', '--get', 'gc.autoDetach'],
    checkoutDir,
    ceilingDir
  );
  return Object.freeze({ maintenanceAutoDetach, gcAutoDetach });
}

/** Fixed working-tree observation; no caller-selected command, extension, textconv or output budget. */
export function readRoomWorkingDiff(checkoutDir: string, ceilingDir: string): Promise<string> {
  return runReadGit(['diff', '--no-ext-diff', '--no-textconv'], checkoutDir, ceilingDir);
}

/** Actual own-repository registration DATA only; this never grants removal permission. */
export async function readRoomWorktreeRegistration(
  repoDir: string,
  ceilingDir: string,
  worktreeDir: string,
  expectedBranch: string
): Promise<Readonly<{ directory: string; branch: string; head: string }> | null> {
  requireRevisionOperand(expectedBranch);
  const bytes = await runReadGitRaw(['worktree', 'list', '--porcelain', '-z'], repoDir, ceilingDir);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\0\0'))
    throw new Error('Invalid native worktree registration encoding/framing.');
  const records = text.slice(0, -2).split('\0\0');
  const directories = new Set<string>();
  let match: Readonly<{ directory: string; branch: string; head: string }> | null = null;
  for (const record of records) {
    const fields = record.split('\0');
    const first = fields.shift();
    if (!first?.startsWith('worktree ') || first.length === 9)
      throw new Error('Invalid native worktree registration path.');
    const directory = first.slice(9);
    if (!path.isAbsolute(directory))
      throw new Error('Native worktree registration is not absolute.');
    const normalized = path.resolve(directory);
    if (directories.has(normalized)) throw new Error('Duplicate native worktree registration.');
    directories.add(normalized);
    const seen = new Set<string>();
    let head: string | undefined, branch: string | undefined;
    let bare = false,
      detached = false,
      locked = false,
      prunable = false;
    for (const field of fields) {
      const space = field.indexOf(' '),
        key = space < 0 ? field : field.slice(0, space);
      const value = space < 0 ? undefined : field.slice(space + 1);
      if (seen.has(key)) throw new Error('Duplicate native worktree registration field.');
      seen.add(key);
      if (key === 'HEAD' && value !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
        head = value;
      else if (key === 'branch' && value?.startsWith('refs/heads/') && value.length > 11)
        branch = value;
      else if (key === 'bare' && value === undefined) bare = true;
      else if (key === 'detached' && value === undefined) detached = true;
      else if (key === 'locked') locked = true;
      else if (key === 'prunable') prunable = true;
      else throw new Error('Unknown or malformed native worktree registration field.');
    }
    if (
      (bare && (head !== undefined || branch !== undefined || detached)) ||
      (!bare && (head === undefined || (detached ? branch !== undefined : branch === undefined)))
    )
      throw new Error('Conflicting native worktree registration.');
    if (
      normalized === path.resolve(worktreeDir) &&
      !bare &&
      !detached &&
      !locked &&
      !prunable &&
      branch === `refs/heads/${expectedBranch}` &&
      head !== undefined
    )
      match = Object.freeze({ directory, branch, head });
  }
  return match;
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

/** Fixed owned refresh write; no caller may supply Git flags or another repository. */
export async function fastForwardRoomWorktree(
  worktree: string,
  tip: string,
  ceilingDir: string,
  context: InstallationRoomMutationContext,
  options: RunGitOptions = {}
): Promise<void> {
  requireRevisionOperand(tip);
  await runOwnedGit(
    ['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--quiet', '--no-stat', tip],
    worktree,
    ceilingDir,
    context,
    options
  );
}

/** Closed status modes used by existing room readers; never a command classifier. */
export function roomStatusRaw(
  checkout: string,
  ceiling: string,
  mode: 'plain' | 'all' | 'all-submodules' | 'ignored' = 'plain',
  nul = false
): Promise<Buffer> {
  if (typeof nul !== 'boolean') throw new Error('Invalid status separator.');
  const args = ['status', '--porcelain=v1'];
  switch (mode) {
    case 'plain':
      break;
    case 'all':
      args.push('--untracked-files=all');
      break;
    case 'all-submodules':
      args.push('--untracked-files=all', '--ignore-submodules=none');
      break;
    case 'ignored':
      args.push('--ignored', '--untracked-files=all');
      break;
    default:
      throw new Error('Invalid room status mode.');
  }
  if (nul) args.push('-z');
  return runReadGitRaw(args, checkout, ceiling);
}

/** Fixed tracked/untracked listings; a literal path cannot become an option. */
export function roomTrackedPathsRaw(
  checkout: string,
  ceiling: string,
  mode: 'plain' | 'staged' | 'tagged' | 'nul' | 'others' = 'plain',
  relative?: string
): Promise<Buffer> {
  const args = ['ls-files'];
  switch (mode) {
    case 'plain':
      break;
    case 'staged':
      args.push('-s');
      break;
    case 'tagged':
      args.push('-v', '-z');
      break;
    case 'nul':
      args.push('-z');
      break;
    case 'others':
      args.push('--others', '-z');
      break;
    default:
      throw new Error('Invalid tracked-path mode.');
  }
  if (relative !== undefined) {
    requireRepoRelativeMutationPath(checkout, relative);
    args.push('--', `:(literal)${relative}`);
  }
  return runReadGitRaw(args, checkout, ceiling);
}

/** Existing worktree ignored-file query with each pattern occupying one fixed -x value slot. */
export function roomHiddenUntrackedRaw(
  checkout: string,
  ceiling: string,
  patterns: readonly string[]
): Promise<Buffer> {
  const args = ['ls-files', '-z', '--others', '--ignored'];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.includes('\0'))
      throw new Error('Invalid exclusion pattern.');
    args.push('-x', pattern);
  }
  return runReadGitRaw(args, checkout, ceiling);
}

/** Read a verified Room repository revision using bounded Git operands. */
export function roomVerifiedTip(
  checkout: string,
  ceiling: string,
  ref: string,
  quiet = false
): Promise<string> {
  requireRevisionOperand(ref);
  if (typeof quiet !== 'boolean') throw new Error('Invalid tip query.');
  return runReadGit(
    ['rev-parse', '--verify', ...(quiet ? ['--quiet'] : []), ref],
    checkout,
    ceiling
  );
}
/** Read the Room repository's symbolic HEAD. */
export function roomSymbolicHead(checkout: string, ceiling: string): Promise<string> {
  return runReadGit(['symbolic-ref', '--quiet', 'HEAD'], checkout, ceiling);
}
/** Count commits between validated Room repository revisions. */
export function roomCommitCount(
  checkout: string,
  ceiling: string,
  from: string,
  to: string,
  firstParent = false
): Promise<string> {
  requireRevisionOperand(from);
  requireRevisionOperand(to);
  if (typeof firstParent !== 'boolean') throw new Error('Invalid commit count mode.');
  return runReadGit(
    ['rev-list', ...(firstParent ? ['--first-parent'] : []), '--count', `${from}..${to}`],
    checkout,
    ceiling
  );
}
/** Read raw changed paths between validated Room repository revisions. */
export function roomChangedPathsRaw(
  checkout: string,
  ceiling: string,
  from: string,
  to: string
): Promise<Buffer> {
  requireRevisionOperand(from);
  requireRevisionOperand(to);
  return runReadGitRaw(['diff', '--name-only', '--no-renames', '-z', from, to], checkout, ceiling);
}
/** Read the merge base of HEAD and a validated Room revision. */
export function roomMergeBase(checkout: string, ceiling: string, tip: string): Promise<string> {
  requireRevisionOperand(tip);
  return runReadGit(['merge-base', 'HEAD', tip], checkout, ceiling);
}

/** Closed formats, positive finite counts and validated revision operands; no caller-selected --output. */
export function roomLogRaw(
  checkout: string,
  ceiling: string,
  format: 'subject' | 'authors' | 'author-subject' | 'hashes' | 'first-parent-subjects',
  count: 1 | 2 | 6 | 8,
  from?: string,
  to?: string
): Promise<Buffer> {
  if (![1, 2, 6, 8].includes(count)) throw new Error('Invalid room log count.');
  let args: string[];
  switch (format) {
    case 'subject':
      args = ['log', '--format=%s', '-n', String(count)];
      break;
    case 'authors':
      args = ['log', '--format=%an <%ae>', '-n', String(count)];
      break;
    case 'author-subject':
      args = ['log', '--format=%an <%ae>%n%s', '-n', String(count)];
      break;
    case 'hashes':
      args = ['log', '--format=%H', '-n', String(count)];
      break;
    case 'first-parent-subjects':
      args = ['log', '--first-parent', `--max-count=${count}`, '-z', '--format=%H%x1f%s'];
      break;
    default:
      throw new Error('Invalid room log format.');
  }
  if (from !== undefined || to !== undefined) {
    if (from === undefined || to === undefined) throw new Error('Both range endpoints required.');
    requireRevisionOperand(from);
    requireRevisionOperand(to);
    args.push(`${from}..${to}`);
  }
  return runReadGitRaw(args, checkout, ceiling);
}
/** Read the size of a validated Room Git object. */
export function roomBlobSize(checkout: string, ceiling: string, object: string): Promise<string> {
  requireRevisionOperand(object);
  return runReadGit(['cat-file', '-s', object], checkout, ceiling);
}
/** Read a validated Room Git object. */
export function roomShowObject(checkout: string, ceiling: string, object: string): Promise<string> {
  requireRevisionOperand(object);
  return runReadGit(['show', object], checkout, ceiling);
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

/** Actual RoomFilesService tree shape: pinned object, NUL names, optional literal relative path. */
export function readRoomFileTreeRaw(
  repoDir: string,
  object: string,
  ceilingDir: string,
  relative?: string
): Promise<Buffer> {
  requireRevisionOperand(object);
  const args = ['ls-tree', '-z', '--long', object];
  if (relative !== undefined) {
    requireRoomFileLiteralPath(repoDir, relative);
    args.push('--', `:(literal)${relative}`);
  }
  return runReadGitRaw(args, repoDir, ceilingDir);
}

/** Actual live maxFileBytes+1024 backstop, not the separate FileOps blob fallback. */
export function readRoomFileContentRaw(
  repoDir: string,
  object: string,
  ceilingDir: string,
  maxBuffer: number
): Promise<Buffer> {
  requireRevisionOperand(object);
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0)
    throw new Error('Expected the positive safe integer live file-content backstop.');
  return runReadGitRaw(['cat-file', 'blob', object], repoDir, ceilingDir, { maxBuffer });
}

/** Actual1000-commit provenance shape with original unpredictable24-hex header marker. */
export function readRoomFileProvenanceRaw(
  repoDir: string,
  commit: string,
  ceilingDir: string,
  dir: string,
  nonce: string
): Promise<Buffer> {
  requireRevisionOperand(commit);
  if (typeof nonce !== 'string' || !/^[0-9a-f]{24}$/.test(nonce))
    throw new Error('Expected the original24-lowercase-hex provenance nonce.');
  if (dir !== '') requireRoomFileLiteralPath(repoDir, dir);
  const fields = `${nonce}%H\u001f%aI\u001f%an\u001f%s`;
  return runReadGitRaw(
    [
      'log',
      '-z',
      '--name-only',
      '--no-renames',
      `--format=${fields}`,
      '-n',
      '1000',
      commit,
      ...(dir === '' ? [] : ['--', `:(literal)${dir}/`]),
    ],
    repoDir,
    ceilingDir
  );
}

/** Fixed blob command for the room file reader; no caller-selected command or tuning. */
export function readRoomFileBlobRaw(
  repoDir: string,
  sha: string,
  ceilingDir: string
): Promise<Buffer> {
  requireRevisionOperand(sha);
  return runReadGitRaw(['cat-file', 'blob', sha], repoDir, ceilingDir, {
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Fixed provenance read used by room-file-ops. */
export function readRoomFileCommitRaw(
  repoDir: string,
  sha: string,
  ceilingDir: string
): Promise<Buffer> {
  requireRevisionOperand(sha);
  return runReadGitRaw(['log', '-1', '--format=%H%x00%an%x00%aI%x00%s', sha], repoDir, ceilingDir);
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
export async function initRepo(
  repoDir: string,
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  const roots = readInstallationRoomMutationRoots(context);
  if (
    typeof repoDir !== 'string' ||
    !path.isAbsolute(repoDir) ||
    path.resolve(repoDir) !== roots.repoPath
  )
    throw new Error('Initialization target must be the captured main repository.');
  await runOwnedGit(
    ['-c', 'init.templateDir=', 'init', '-b', 'main', '--quiet', '.'],
    repoDir,
    ceilingDir,
    context
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
    await runReadGit(
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
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<string> {
  await runOwnedGit(['add', '--all'], repoDir, ceilingDir, context);
  return commitStaged(repoDir, message, identity, ceilingDir, context);
}

/**
 * Stage exactly these paths, and nothing else.
 *
 * `:(literal)` on every pathspec, so a member's filename means itself: without
 * it a file called `*` stages its whole directory and one called `!x` means
 * "not x". That is the same magic {@link listTree}'s callers guard against when
 * they READ a path, applied where it can actually change what gets committed.
 *
 * Its own step rather than part of a commit, because a caller that stages a
 * single path needs to know whether anything was staged at all
 * ({@link hasStagedChanges}) before it decides to commit — a person saving a
 * file they did not change is not an error, and it is not history either.
 *
 * @param repoDir - The checkout to stage in.
 * @param paths - Repo-relative paths. Already normalised by the caller.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function stagePaths(
  repoDir: string,
  paths: readonly string[],
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  readInstallationRoomMutationRoots(context);
  const pathTargets = paths.map((value) => requireRepoRelativeMutationPath(repoDir, value));
  await checkInstallationRoomMutationTarget(context, repoDir);
  if (paths.length === 0) return;
  await runOwnedGit(
    ['add', '--', ...paths.map((filePath) => `:(literal)${filePath}`)],
    repoDir,
    ceilingDir,
    context,
    {},
    pathTargets
  );
}

/**
 * Whether the index holds anything the current commit does not.
 *
 * `--quiet` makes git answer in its exit status — `1` for "there is a
 * difference" — which is why the failure is READ rather than propagated. Any
 * other exit is a real failure and goes back to the caller.
 *
 * `--cached` compares the index against `HEAD`, and on a repo whose first
 * commit has not happened git compares against the empty tree instead, so a
 * first file answers `true` rather than failing.
 *
 * @param repoDir - The checkout to ask.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function hasStagedChanges(repoDir: string, ceilingDir: string): Promise<boolean> {
  try {
    await runReadGit(['diff', '--cached', '--quiet'], repoDir, ceilingDir);
    return false;
  } catch (err) {
    if (err instanceof GitUnavailableError) throw err;
    if ((err as { code?: unknown })?.code === 1) return true;
    throw err;
  }
}

/**
 * Commit whatever is staged, under `identity`.
 *
 * The half of {@link commitAll} that is about authorship rather than about
 * staging, split out so a caller that staged one path can reuse it without
 * `--all` sweeping in whatever else happens to be in the tree.
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
export async function commitStaged(
  repoDir: string,
  message: string,
  identity: GitIdentity,
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<string> {
  await runOwnedGit(
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
    ceilingDir,
    context
  );
  return runOwnedGit(['rev-parse', 'HEAD'], repoDir, ceilingDir, context);
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
 * Everything in a checkout that is not committed — staged, unstaged and
 * untracked alike, one record each.
 *
 * The richer twin of {@link hasUncommittedChanges}, and it exists because the
 * integration tree needs a different answer from a worktree. For a worktree the
 * question is yes/no: may this be thrown away. For `repo/` the answer has to be
 * SHOWN to a person and then acted on file by file — the spec's dirty-main
 * degradation offers "commit these" or "discard exactly these", and neither is
 * expressible without the list.
 *
 * `--porcelain=v1 -z` because it is the only stable format that can carry a
 * filename holding a newline or a quote, which a room's members can commit.
 * `--untracked-files=all` lists files inside a new directory individually
 * rather than naming the directory, so every entry is something the discard
 * path can name literally.
 *
 * **A rename is TWO records in `-z` output** (`R  <new>NUL<old>NUL`), and the
 * old path is consumed rather than reported: reporting it would offer the
 * person a path that is not there to discard.
 *
 * @param checkoutDir - The checkout to inspect.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns One record per path, in git's own order.
 */
export async function listStrayChanges(
  checkoutDir: string,
  ceilingDir: string
): Promise<StrayChange[]> {
  // **Raw, because the private text launcher trims and a status record can BEGIN with a
  // space.** ` M notes.md` — unmodified in the index, modified in the tree — is
  // the ordinary shape of an edit somebody made in a terminal, and trimming it
  // shifts every field of the record it starts. Filenames may legitimately
  // begin with whitespace too. Nothing here rewrites git's bytes.
  const out = (
    await runReadGitRaw(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      checkoutDir,
      ceilingDir,
      // A tree somebody dropped a build directory into can list a very large
      // number of untracked files, and this is the one status read that has to
      // survive it rather than fail the whole room's degradation report.
      { maxBuffer: LARGE_OUTPUT_MAX_BUFFER }
    )
  ).toString('utf-8');
  const records = out.split('\0');
  const strays: StrayChange[] = [];
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at];
    // `XY <path>`: two status letters, a space, then the path — so anything
    // shorter than four characters is not a record.
    if (!record || record.length < 4) continue;
    const index = record[0] ?? ' ';
    const worktree = record[1] ?? ' ';
    const filePath = record.slice(3);
    // The old name of a rename or a copy follows in its own record. It is
    // consumed rather than listed — offering it would offer a path that is not
    // there — and kept on the record it belongs to, because undoing the rename
    // means restoring it. See {@link StrayChange.renamedFrom}.
    const renamedFrom = index === 'R' || index === 'C' ? records[++at] : undefined;
    strays.push({
      path: filePath,
      kind: strayKind(index, worktree),
      ...(renamedFrom ? { renamedFrom } : {}),
    });
  }
  return strays;
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

/**
 * Whether this repo's own ignore rules exclude a path.
 *
 * `check-ignore -q` answers in its exit status — `0` ignored, `1` not, anything
 * else a real failure — which is why the `1` is read rather than propagated.
 * `--no-index` asks about the RULES rather than about what is already tracked,
 * so a file that is both tracked and matched by a rule answers honestly instead
 * of being excused by its own history.
 *
 * **The one command here that cannot take `:(literal)`** — `check-ignore`
 * refuses pathspec magic outright ("pathspec magic not supported by this
 * command"), so the path goes in bare, after `--` so a name beginning with a
 * dash is still a path rather than an option. The cost is that a filename
 * containing glob characters is tested as the pattern it looks like, which can
 * answer "ignored" for a file that is not. That direction is the safe one: it
 * refuses a save that would have worked, with a sentence saying why, rather
 * than committing something the room excludes.
 *
 * @param repoDir - The checkout whose rules to ask.
 * @param filePath - A normalised repo-relative path.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function isIgnored(
  repoDir: string,
  filePath: string,
  ceilingDir: string
): Promise<boolean> {
  try {
    await runReadGit(['check-ignore', '-q', '--no-index', '--', filePath], repoDir, ceilingDir);
    return true;
  } catch (err) {
    if (err instanceof GitUnavailableError) throw err;
    if ((err as { code?: unknown })?.code === 1) return false;
    // **Anything else is this command failing on the PATH, and it is named as
    // that rather than propagated raw.** `check-ignore` exits 128 on a pathspec
    // it cannot parse — the magic it does not support — and letting that out
    // reached the global handler as a 500 with no code, which is both a lie
    // about whose fault it was and unactionable (`:!x.md`, found in review).
    // Its own type, like the two failures above it, so the caller translates it
    // into the room's own refusal instead of guessing from a message.
    throw new UnreadablePathError(filePath, err);
  }
}

/**
 * Which of these paths the commit `HEAD` names actually holds.
 *
 * The question a discard has to answer before it picks HOW to undo a change: a
 * path that is in `HEAD` is restored from it, and a path that is not can only
 * be removed. Asked in ONE command for every path, and asked of git rather than
 * of the index, because the index is one of the things a stray change may have
 * touched.
 *
 * @param repoDir - The checkout to ask.
 * @param paths - Repo-relative paths.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns The subset of `paths` that `HEAD` holds.
 */
export async function pathsInHead(
  repoDir: string,
  paths: readonly string[],
  ceilingDir: string
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  // Raw for the reason {@link listStrayChanges} gives: a filename may begin or
  // end with whitespace, and a trimmed answer would fail to match the path the
  // caller asked about — which here would mean choosing the wrong way to undo
  // it.
  const out = (
    await runReadGitRaw(
      [
        'ls-tree',
        '-z',
        '--name-only',
        'HEAD',
        '--',
        ...paths.map((filePath) => `:(literal)${filePath}`),
      ],
      repoDir,
      ceilingDir
    )
  ).toString('utf-8');
  return new Set(out.split('\0').filter((name) => name !== ''));
}

/**
 * Put these paths back the way `HEAD` has them, in the index and in the tree.
 *
 * `git checkout HEAD --` rather than `git restore`, because it is one command
 * for both halves and it has meant the same thing in every git a person might
 * have. Every path is a `:(literal)` pathspec, so a filename never behaves as a
 * glob.
 *
 * **Destructive, and deliberately narrow**: it undoes exactly the paths it is
 * given and never a directory, so the caller has to have named each file.
 *
 * @param repoDir - The checkout to restore in.
 * @param paths - Repo-relative paths, all of which `HEAD` holds.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function restoreFromHead(
  repoDir: string,
  paths: readonly string[],
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  readInstallationRoomMutationRoots(context);
  const pathTargets = paths.map((value) => requireRepoRelativeMutationPath(repoDir, value));
  await checkInstallationRoomMutationTarget(context, repoDir);
  if (paths.length === 0) return;
  await runOwnedGit(
    ['checkout', 'HEAD', '--', ...paths.map((filePath) => `:(literal)${filePath}`)],
    repoDir,
    ceilingDir,
    context,
    {},
    pathTargets
  );
}

/**
 * Take these paths out of the index.
 *
 * The other half of a discard: a path that `HEAD` does not hold cannot be
 * restored from it, so what "undo" means for one is that its file goes away and
 * it stops being staged. The caller deletes the file itself — no subprocess, and
 * no `git clean`, a command whose whole reputation is for removing more than it
 * was asked to.
 *
 * **Call this AFTER deleting the file, not before**, and the order is a fix
 * rather than a preference. `git rm --cached` refuses a path whose staged
 * content differs from both `HEAD` and the file on disk — the state a person
 * leaves behind by staging something and then editing it again — and the
 * documented way past that refusal is `-f`, a flag this domain does not use and
 * a test forbids by name. With the file already gone there is nothing to
 * disagree with, and the same call succeeds. Measured both ways.
 *
 * `--ignore-unmatch` so a path that was never staged at all — an ordinary
 * untracked file — is a no-op rather than a failure.
 *
 * @param repoDir - The checkout to unstage in.
 * @param paths - Repo-relative paths, whose files are already deleted.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function unstagePaths(
  repoDir: string,
  paths: readonly string[],
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  readInstallationRoomMutationRoots(context);
  const pathTargets = paths.map((value) => requireRepoRelativeMutationPath(repoDir, value));
  await checkInstallationRoomMutationTarget(context, repoDir);
  if (paths.length === 0) return;
  await runOwnedGit(
    [
      'rm',
      '--cached',
      '--quiet',
      '--ignore-unmatch',
      '--',
      ...paths.map((filePath) => `:(literal)${filePath}`),
    ],
    repoDir,
    ceilingDir,
    context,
    {},
    pathTargets
  );
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
  return (await runReadGit(['status', '--porcelain=v1'], checkoutDir, ceilingDir)).length > 0;
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
  const out = await runReadGit(['rev-list', '--count', 'main..HEAD'], checkoutDir, ceilingDir);
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
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  requireRevisionOperand(branch);
  if (createFrom !== null) requireRevisionOperand(createFrom);
  const args = createFrom
    ? ['worktree', 'add', '--quiet', '-b', branch, worktreeDir, createFrom]
    : ['worktree', 'add', '--quiet', worktreeDir, branch];
  await runOwnedGit(args, repoDir, ceilingDir, context, {}, [worktreeDir]);
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
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  await runOwnedGit(['worktree', 'remove', worktreeDir], repoDir, ceilingDir, context, {}, [
    worktreeDir,
  ]);
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
export async function pruneWorktrees(
  repoDir: string,
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<void> {
  await runOwnedGit(['worktree', 'prune'], repoDir, ceilingDir, context);
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
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<boolean> {
  requireRevisionOperand(branch);
  const launch: NativeLaunch = { started: false };
  try {
    await runOwnedGit(
      ['branch', '--quiet', '-d', branch],
      repoDir,
      ceilingDir,
      context,
      {},
      [],
      launch
    );
    return true;
  } catch (err) {
    if (!launch.started || err instanceof GitUnavailableError) throw err;
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
 * A checkout with no commits yet answers `null` rather than throwing, which the
 * caller reads as "this tree has no commit date" and moves on to its other
 * sources. That case is `git log` exiting 128 with "does not have any commits
 * yet" — caught here, because the alternative was a contract that said `null`
 * and a function that threw. Every OTHER failure still propagates: an
 * unreadable tree must not be spelled the same way as an empty one, which is
 * the mistake {@link commitsAheadOfMain} was fixed for.
 *
 * @param checkoutDir - The checkout to ask.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns The commit time, or `null` when there are no commits yet.
 * @throws When the checkout cannot be read at all.
 */
export async function headCommittedAt(
  checkoutDir: string,
  ceilingDir: string
): Promise<Date | null> {
  let iso: string;
  try {
    iso = await runReadGit(['log', '-1', '--format=%cI'], checkoutDir, ceilingDir);
  } catch (err) {
    if (err instanceof GitUnavailableError) throw err;
    const stderr = String((err as { stderr?: unknown })?.stderr ?? '');
    if (/does not have any commits yet|unknown revision or path/i.test(stderr)) return null;
    throw err;
  }
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * How far one branch has run ahead of another, and how far behind.
 *
 * `rev-list --left-right --count a...b` counts the commits reachable from
 * exactly one side of the symmetric difference: the left number is what `a` has
 * and `b` has not (`behind`, from `b`'s point of view), the right is what `b`
 * has and `a` has not (`ahead`). Asked in the MAIN checkout so a status sweep
 * never has to enter somebody else's working copy.
 *
 * @param repoDir - The room's main checkout.
 * @param base - The integration branch, normally `main`.
 * @param branch - The branch being measured against it.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns How many commits `branch` holds that `base` does not, and vice versa.
 */
export async function aheadBehind(
  repoDir: string,
  base: string,
  branch: string,
  ceilingDir: string
): Promise<{ ahead: number; behind: number }> {
  requireRevisionOperand(base);
  requireRevisionOperand(branch);
  const out = await runReadGit(
    ['rev-list', '--left-right', '--count', `${base}...${branch}`],
    repoDir,
    ceilingDir
  );
  const [behind, ahead] = out.split(/\s+/).map((part) => Number.parseInt(part, 10) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
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

/**
 * Every blob in a commit's tree, with its mode, object id and size.
 *
 * `-r` recurses (so no sub-tree entries come back), `-l` adds the size, and
 * `-z` makes the record separator a NUL — which is the only way to read a path
 * that contains a newline, and paths in a repo members write to are not this
 * module's to trust.
 *
 * One command for the whole tree rather than one per changed file: the merge
 * validation needs both the delta (what changed) and the total (what the repo
 * would weigh), and comparing two of these answers both without a second pass.
 *
 * @param repoDir - The room's main checkout.
 * @param commitish - The commit or branch whose tree to list.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns Every blob, keyed by path.
 */
export async function listTree(
  repoDir: string,
  commitish: string,
  ceilingDir: string
): Promise<Map<string, TreeEntry>> {
  requireRevisionOperand(commitish);
  const out = await runReadGit(
    ['ls-tree', '-r', '-l', '-z', commitish],
    repoDir,
    ceilingDir,
    // A tree listing is one line per file, so a large repo outruns the shared
    // default — measured to break around 15-20k files against `execFile`'s own
    // 1 MB, and it surfaces as an unmapped 500 rather than as anything a caller
    // could act on. Asked for explicitly rather than left to
    // {@link GIT_MAX_OUTPUT_BYTES}, because this command's output is the one
    // that scales with the whole repository.
    { maxBuffer: LARGE_OUTPUT_MAX_BUFFER }
  );
  const entries = new Map<string, TreeEntry>();
  for (const record of out.split('\0')) {
    if (record.length === 0) continue;
    // `<mode> SP <type> SP <sha> SP <size> TAB <path>`, with the size
    // right-aligned in a padded column and `-` for anything that is not a blob.
    const match = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(record);
    if (!match) continue;
    const [, mode, type, sha, size, entryPath] = match;
    // **`commit` is kept, and dropping it was a hole.** A gitlink is type
    // `commit`, so a filter of `type !== 'blob'` removed submodules from the
    // listing entirely — which meant they appeared in neither the before tree
    // nor the after tree, were therefore never in the delta, and reached `main`
    // without meeting a single check. They are listed here so the caller can
    // refuse them by name.
    if ((type !== 'blob' && type !== 'commit') || !mode || !sha || !entryPath) continue;
    entries.set(entryPath, {
      path: entryPath,
      mode,
      sha,
      size: size === '-' ? 0 : Number.parseInt(size, 10) || 0,
    });
  }
  return entries;
}

/**
 * The content of one blob, as text.
 *
 * Used for exactly one thing: reading where a symlink points, which is a short
 * path and never a file the caller has not already size-checked. It trims,
 * which a general blob reader must not — a symlink target with trailing
 * whitespace is not a target anybody meant, and trimming can only make the
 * escape check stricter.
 *
 * @param repoDir - The room's main checkout.
 * @param sha - The blob to read.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns The blob's content, trimmed.
 */
export async function readBlob(repoDir: string, sha: string, ceilingDir: string): Promise<string> {
  requireRevisionOperand(sha);
  return runReadGit(['cat-file', 'blob', sha], repoDir, ceilingDir);
}

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
 * How large the delta between two commits is, in files and lines.
 *
 * `--shortstat` rather than counting `--numstat` rows, because the numbers are
 * for a sentence a person reads in the room ("4 files, +120/−8") and git
 * already writes that sentence. A delta of nothing answers all zeros, which is
 * what an empty `--shortstat` line means.
 *
 * @param repoDir - The room's main checkout.
 * @param from - The commit the delta starts at.
 * @param to - The commit it ends at.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns The counts.
 */
export async function shortstat(
  repoDir: string,
  from: string,
  to: string,
  ceilingDir: string
): Promise<DiffStat> {
  requireRevisionOperand(from);
  requireRevisionOperand(to);
  const out = await runReadGit(['diff', '--shortstat', from, to], repoDir, ceilingDir);
  const read = (pattern: RegExp): number => Number.parseInt(pattern.exec(out)?.[1] ?? '0', 10) || 0;
  return {
    files: read(/(\d+) files? changed/),
    insertions: read(/(\d+) insertions?\(\+\)/),
    deletions: read(/(\d+) deletions?\(-\)/),
  };
}

/**
 * The commit a ref points at right now.
 *
 * @param checkoutDir - The checkout to ask.
 * @param ref - The ref to resolve.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns The full sha.
 */
export async function revParse(
  checkoutDir: string,
  ref: string,
  ceilingDir: string
): Promise<string> {
  requireRevisionOperand(ref);
  return runReadGit(['rev-parse', ref], checkoutDir, ceilingDir);
}

/**
 * The branch a checkout has checked out, or `null` when its HEAD is detached.
 *
 * The main checkout of a room repo is only ever on `main` — the server is its
 * only writer and never leaves it — so anything else is an out-of-band change,
 * which the merge refuses rather than merging into whatever it finds.
 *
 * @param checkoutDir - The checkout to ask.
 * @param ceilingDir - The room home directory the search may not climb past.
 */
export async function currentBranch(
  checkoutDir: string,
  ceilingDir: string
): Promise<string | null> {
  const name = await runReadGit(['rev-parse', '--abbrev-ref', 'HEAD'], checkoutDir, ceilingDir);
  return name === 'HEAD' ? null : name;
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

/**
 * Merge `branch` into whatever `repoDir` has checked out, always as a real
 * merge commit — and leave nothing behind if it fails.
 *
 * **`--no-ff` is the point, not a preference.** The caller has already refused
 * anything that is behind `main`, so every merge that gets here COULD fast
 * forward; letting it would erase the fact that the work happened on a branch,
 * and a room's log says "Ana merged …" about a commit that would then not
 * exist. One merge, one commit, one entry.
 *
 * **The abort is this function's own job**, and that is why the merge is here
 * rather than assembled by the caller. A conflicted `git merge` leaves the
 * checkout mid-merge — an index full of conflict stages, `MERGE_HEAD` written
 * — and the next merge into that tree would be refused, or worse, would commit
 * somebody's conflict markers. `git merge --abort` puts the tree back exactly
 * where it was, and it runs in a `finally`-shaped path so no error route can
 * skip it. The abort's own failure is recorded as cleanupCause on the original
 * merge failure; it cannot replace the original cause, even when that cause
 * is undefined. Pre-launch ownership/configuration refusals do not launch an abort.
 *
 * `--no-verify` is deliberately absent, unlike {@link commitAll}. It is a newer
 * option on `merge` than on `commit`, and `core.hooksPath` — applied to every
 * command in this module — is what actually stops a hook running (see the
 * module doc, where that was measured).
 *
 * @param repoDir - The checkout to merge INTO. Must be clean.
 * @param branch - The branch to merge in.
 * @param message - The merge commit's message. Sanitized by the caller.
 * @param identity - Who the merge commit is attributed to.
 * @param ceilingDir - The room home directory the search may not climb past.
 * @returns The new merge commit's full sha.
 * @throws {MergeConflictError} When the merge did not complete. The checkout is
 *   back at its previous commit, unmodified.
 */
export async function mergeNoFf(
  repoDir: string,
  branch: string,
  message: string,
  identity: GitIdentity,
  ceilingDir: string,
  context: InstallationRoomMutationContext
): Promise<string> {
  requireRevisionOperand(branch);
  const launch: NativeLaunch = { started: false };
  try {
    await runOwnedGit(
      [
        '-c',
        `user.name=${identity.name}`,
        '-c',
        `user.email=${identity.email}`,
        'merge',
        '--no-ff',
        '--quiet',
        '-m',
        message,
        branch,
      ],
      repoDir,
      ceilingDir,
      context,
      {},
      [],
      launch
    );
  } catch (err) {
    if (!launch.started || err instanceof GitUnavailableError || err instanceof RoomError)
      throw err;
    const failure = new MergeConflictError(branch, err);
    try {
      await runOwnedGit(['merge', '--abort'], repoDir, ceilingDir, context);
    } catch (cleanupCause) {
      Object.defineProperty(failure, 'cleanupCause', { value: cleanupCause });
    }
    throw failure;
  }
  return runOwnedGit(['rev-parse', 'HEAD'], repoDir, ceilingDir, context);
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
  return runReadGit(['rev-parse', '--absolute-git-dir'], checkoutDir, ceilingDir);
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
  const dir = await runReadGit(['rev-parse', '--git-common-dir'], checkoutDir, ceilingDir);
  return path.resolve(checkoutDir, dir);
}
