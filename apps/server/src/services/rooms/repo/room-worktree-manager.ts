/**
 * One standing working copy per (room, agent), and the sweep that tidies the
 * empty ones away (spec `project-rooms` §3.4).
 *
 * A room's repo has exactly one integration tree — `repo/`, on `main`, written
 * only by the server — and every agent that works in the room gets its own
 * checkout beside it under `worktrees/<slug>/`, on its own `room/<slug>`
 * branch. That is the DOR-500 invariant applied to rooms: one tree, one writer.
 * Two agents editing the same file at the same time is then not a race anybody
 * has to arbitrate; it is two branches and a merge.
 *
 * ## The reap spares work, and exactly which gate does that
 *
 * `config.rooms.repo.worktreeReapDays` is filed as a no-risk setting — no value
 * of it can lose work — and the reason is here rather than in the config
 * schema. A worktree is removed only when FOUR independent things agree:
 *
 * 1. Its agent is not mid-turn ({@link RoomWorktreeManagerDeps.busyAgentPaths}).
 *    Once the cwd rung lands (task 2.2) a room turn RUNS in this directory, and
 *    a turn that is only reading — think, then write — leaves no mark any date
 *    source below can see. Deleting the cwd out from under a live turn is the
 *    one way this sweep could break something that was not even idle.
 * 2. It is not in {@link RoomWorktreeManagerDeps.listStrandedWorktrees}, which
 *    is the delete guard's own list: anything dirty, anything holding commits
 *    `main` has never seen, and anything git cannot read at all.
 * 3. Nothing in it has been touched inside the idle window.
 * 4. `git worktree remove` — **without `--force`** — agrees to remove it, and
 *    then `git branch -d` — never `-D` — agrees to retire the branch.
 *
 * **These gates are not interchangeable, and an earlier version of this note
 * claimed they were.** Only gate 2 is complete. `git worktree remove` refuses a
 * tree holding modified or untracked files and says nothing about unmerged
 * COMMITS; `git branch -d` refuses a branch `main` does not contain and says
 * nothing about uncommitted EDITS. Each covers one half, which is why the tree
 * and the branch are reported separately: a removal whose branch survived is
 * `reapedTreeKeptBranch`, never `reaped`, because something was left behind on
 * purpose and a person may want to know. Gate 2 is pinned
 * red-before/green-after in this module's tests — remove it and a
 * clean-but-unmerged worktree is deleted along with its working copy.
 *
 * **The commit-between-list-and-removal window is closed by design, so do not
 * "fix" it by reordering.** An agent could in principle commit after gate 2
 * read the tree and before gate 4 removes it, which no `git status` check would
 * catch. It cannot matter here: `lastTouchedAt` reads `HEAD`'s committer date,
 * that read happens after the stranded list, and `worktreeReapDays` is
 * `.min(1)` in the schema — so a commit made anywhere near the sweep puts the
 * tree inside the idle window and gate 3 spares it. Shortening the minimum to
 * zero would open this; the schema minimum is load-bearing.
 *
 * The reap is the ONLY thing that removes a worktree. Leaving a room does not:
 * membership is about who is talked to, and an agent that leaves with unmerged
 * work still has it when it comes back (§3.4).
 *
 * ## Two agents, one name
 *
 * Worktree directories are named `<slug>-<8 hex>`, where the slug is the
 * agent's name made filesystem-safe and the hex is the front of a SHA-256 of
 * the agent's resolved workspace path. The suffix is unconditional rather than
 * added on collision, because a collision-triggered suffix is not stable: two
 * agents called "Ana" would get `ana` and `ana-2` depending on which one
 * arrived first, and deleting the first would silently change the second's
 * answer. Hashing the workspace path instead makes the name a pure function of
 * the agent's own identity anchor (`.dork/agent.json` lives at that path,
 * ADR-0043) — the same agent always gets the same worktree, whoever else is in
 * the room.
 *
 * Two consequences, both intended: renaming an agent, or moving its workspace,
 * gives it a NEW worktree and leaves the old one to the reap (clean, so it
 * goes; dirty, so it is surfaced as stranded work). And on a case-insensitive
 * filesystem two spellings of one path hash differently, so an agent
 * registered twice under different spellings gets two worktrees — harmless,
 * and not worth lowercasing a path for on the systems where case is real.
 *
 * The path is normalized with `path.resolve` and deliberately NOT `realpath`.
 * Resolving symlinks would be the more "correct" identity, and it would also
 * make a worktree's name depend on where a link happens to point today: move
 * the link and every agent it names silently changes worktree, stranding the
 * one it was working in. A lexical path is a name the person chose, so an agent
 * reached through a symlink gets a second worktree and keeps both — visible,
 * and fixable by them rather than by us.
 *
 * ## Harness projection, and why it cannot dirty the tree
 *
 * A room repo may carry `.agents/skills/` like any project (§3.8), and Claude
 * Code — the default runtime — only reads skills from `.claude/skills/`. So
 * every fresh worktree gets the same projection an agent workspace gets
 * ({@link projectAgentWorkspace}: claude-code only, no dork home, no plugin
 * hooks, never throws).
 *
 * That projection WRITES into the agent's tree, and everything above depends on
 * `git status` in that tree meaning "the agent's unsaved work". Left alone, a
 * room repo carrying one skill would produce a `.claude/skills/` symlink that
 * makes every worktree permanently dirty: never reaped, and — once §3.6 lands —
 * never mergeable either. So the generated paths are excluded in the repo's
 * shared `info/exclude` before the first worktree is added.
 *
 * The list holds only what DorkOS generates in THIS configuration, and nothing
 * a person might write. Two paths were considered and left out, for the same
 * reason: `.claude/commands/` (members author commands there for claude-code)
 * and `.claude/settings.local.json` — which the harness engine treats as the
 * person's own file, and which this projection never generates anyway, because
 * it runs claude-code-only with plugin hooks denied. Excluding a file DorkOS
 * does not write would hide somebody's settings from `git status` and then let
 * the reap delete them without a word. Anything generated that is left visible
 * makes its worktree read dirty, which is the conservative direction: spared,
 * never deleted.
 *
 * **An exclude cannot hide a TRACKED file**, which is what makes the two
 * entries safe: a room that commits its own harness manifest keeps working on
 * it normally.
 *
 * @module server/services/rooms/repo/room-worktree-manager
 */
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { slugifyAgentName } from '@dorkos/shared/validation';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../room-errors.js';
import {
  projectAgentWorkspace,
  type AgentWorkspaceProjection,
} from '../../harness/project-agent-workspace.js';
import type { RoomRepoStore } from './room-repo-store.js';
import {
  addWorktree,
  commitsAheadOfMain,
  commonGitDir,
  deleteMergedBranch,
  hasLocalBranch,
  hasUncommittedChanges,
  headCommittedAt,
  pruneWorktrees,
  removeWorktree,
} from './room-repo-git.js';

/**
 * How many hex characters of the workspace-path digest ride in a worktree name.
 *
 * Eight — 32 bits. These are not adversarial inputs (an agent cannot choose
 * another agent's workspace path) and the population is the agents of one room,
 * so this is about accidents, not attacks: eight characters keeps the directory
 * name readable in `git worktree list` and in the explorer while making an
 * accidental clash between two agents in one room a non-event.
 */
const SLUG_DIGEST_CHARS = 8;

/**
 * How much of the agent's name survives into the directory name.
 *
 * `slugifyAgentName` allows 64, which with the digest would make some worktree
 * paths longer than the rest of the room home put together. Forty is still a
 * name a person recognizes at a glance.
 */
const SLUG_NAME_CHARS = 40;

/**
 * The branch a room worktree checks out, given its slug.
 *
 * Not exported from the domain barrel: the branch name is this module's
 * business, and every surface above it takes the name from
 * {@link RoomWorktreeHandle.branch} rather than rebuilding it.
 */
export function roomWorktreeBranch(slug: string): string {
  return `room/${slug}`;
}

/**
 * The `info/exclude` block that keeps harness projection out of `git status`.
 *
 * Marker-delimited so the block can be recognized and left alone on the next
 * call rather than appended twice, and so a person reading the file knows what
 * wrote it and why. See the module doc for the two paths deliberately NOT in
 * it, and why excluding a file DorkOS does not generate would be worse than
 * leaving a generated one visible.
 */
const EXCLUDE_BLOCK = [
  '# --- DorkOS: harness projection output, not anybody’s work (room-worktree-manager.ts) ---',
  '/.claude/skills/',
  '/.agents/harness.manifest.json',
  '# --- end DorkOS ---',
].join('\n');

/** The first line of {@link EXCLUDE_BLOCK}, used to detect an existing block. */
const EXCLUDE_MARKER = EXCLUDE_BLOCK.split('\n')[0] ?? '';

/** One agent's standing working copy in one room. */
export interface RoomWorktreeHandle {
  /** The directory name under `worktrees/`, and the tail of the branch name. */
  slug: string;
  /** Absolute path to the working copy — the cwd a room turn runs in. */
  path: string;
  /** The branch checked out in it. */
  branch: string;
  /**
   * Whether this resolution is what created the tree.
   *
   * Shared by concurrent callers: two turns asking at the same moment await one
   * creation and both see `true`, because both are looking at a tree that did
   * not exist when they asked. It answers "was this made just now", not "was
   * mine the winning call".
   */
  created: boolean;
  /**
   * What harness projection did, when this resolution created the worktree.
   *
   * `null` when the worktree was already there — projection runs at create
   * (spec §5 Q5), and re-running it every turn would make the server a writer
   * in a tree the agent owns.
   */
  projection: AgentWorkspaceProjection | null;
}

/** What one worktree holds, for the reap and for `room_repo_status` (§3.6). */
export interface RoomWorktreeStatus {
  /** The directory name under `worktrees/`. */
  slug: string;
  /** Absolute path to the working copy. */
  path: string;
  /** Whether it holds changes that are not committed. */
  dirty: boolean;
  /** How many commits it holds that `main` does not. */
  aheadOfMain: number;
  /**
   * The most recent moment anything in it moved, as an ISO timestamp.
   *
   * See {@link RoomWorktreeManager.lastTouchedAt} for what is and is not
   * counted — the answer is deliberately bounded rather than a full walk.
   */
  lastTouchedAt: string;
}

/** What one reap pass did to one room's worktrees. */
export interface RoomWorktreeSweepResult {
  /** Worktrees fully gone: working copy removed AND branch retired. */
  reaped: string[];
  /**
   * Worktrees whose working copy was removed while their branch was kept.
   *
   * Its own field rather than a line in `reaped`, because it is a different
   * outcome and the difference is a person's business: `git branch -d` refused,
   * which can only mean `main` does not contain that branch, which can only
   * mean something got committed after the stranded list was taken. Nothing was
   * lost — the commits are still on the branch — but "we tidied that away"
   * would be a false summary of it.
   */
  reapedTreeKeptBranch: string[];
  /**
   * Worktrees kept because they are in use or were touched recently.
   *
   * Covers both "an agent is mid-turn in it" and "something in it moved inside
   * the idle window", plus the working copies git declined to remove.
   */
  spared: string[];
  /**
   * Worktrees kept because they hold work `main` does not have.
   *
   * Includes the ones git could not read at all: a directory nothing can
   * inspect is somebody's unfinished work until proven otherwise.
   */
  stranded: string[];
}

/** The seams {@link RoomWorktreeManager} needs from the rest of the server. */
export interface RoomWorktreeManagerDeps {
  /** Owns every path under a room's home; never construct one by hand. */
  store: RoomRepoStore;
  /**
   * Whether this room has files a caller may use right now.
   *
   * `RoomRepoService.hasRepo` in production, which is false while
   * `config.rooms.repo.enabled` is off — so switching the feature off stops
   * new worktrees AND stops the reap, rather than tidying away trees nobody
   * can currently reach.
   */
  hasRepo(roomId: string): boolean;
  /**
   * Which of a room's worktrees hold work `main` does not have.
   *
   * `RoomRepoService.listStrandedWorktrees` in production. The reap consults
   * it and removes nothing on it — that is the whole safety argument, so it is
   * a dependency rather than a reimplementation.
   */
  listStrandedWorktrees(roomId: string): Promise<string[]>;
  /** `config.rooms.repo.worktreeReapDays`, read per call. */
  reapAfterDays(): number;
  /**
   * The workspace path of every agent holding a live room claim right now.
   *
   * `RoomService.listBusyAgentPaths` in production, straight off the claim map
   * that already bounds one checkout per agent (`room-claims.ts`).
   *
   * **The enumerable form of "is this (room, agent) busy", and it has to be.**
   * The reap walks directory NAMES, and a name is `<slug>-<digest of the agent
   * path>` — a one-way hash. There is no way back from a directory to the agent
   * that owns it, so the question is asked in the only direction that can be
   * answered: list the busy paths, digest each one, and skip the directories
   * that match.
   *
   * Install-wide rather than per-room, deliberately. An agent mid-turn in room
   * B is not writing in room A's worktree, so room-scoping would be more
   * precise — and being wrong in that direction deletes a live cwd, while being
   * wrong in this one delays a tidy-up by five minutes.
   */
  busyAgentPaths(): readonly string[];
  /**
   * The wall clock, as epoch ms. Defaults to `Date.now`.
   *
   * Injectable for ONE reason: the reap's idle decision and the directory stamp
   * must be drivable from a single deterministic source in tests, so a test
   * never has to age a worktree by writing real mtimes into the past and then
   * race a real `git` that might refresh them. Advancing this clock past the cap
   * makes a freshly created worktree "idle" without touching a single mtime —
   * which is exactly the kind of coupling the index-mtime removal exists to
   * kill. In production it is `Date.now` and nothing changes.
   */
  now?: () => number;
}

/**
 * Creates, describes and reaps the standing working copies of a room's repo.
 *
 * Everything here is keyed on the room's own home directory as git's discovery
 * ceiling, so a directory under `worktrees/` that is not a checkout fails
 * loudly instead of answering for whatever repository encloses the DorkOS data
 * directory (`room-repo-git.ts`).
 */
export class RoomWorktreeManager {
  /**
   * In-flight creations, keyed `<roomId>/<slug>`.
   *
   * Two turns for one agent can resolve their cwd at the same moment, and
   * `git worktree add` on a directory another call is halfway through creating
   * fails. Sharing the promise makes the second caller wait for the first
   * rather than race it — the same shape the session-boundary code uses for
   * anything that must happen once.
   */
  private readonly creating = new Map<string, Promise<RoomWorktreeHandle>>();

  /**
   * Bind the manager to one install's store and settings.
   *
   * @param deps - The seams above.
   */
  constructor(private readonly deps: RoomWorktreeManagerDeps) {}

  /** Epoch ms from the injected clock, or the wall clock. */
  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * The directory name one agent's worktree takes in any room.
   *
   * Stable for an agent across rooms, restarts and other agents coming and
   * going — see the module doc for why the digest is unconditional rather than
   * a tiebreak.
   *
   * @param agentName - The agent's display name, or its registry name.
   * @param agentPath - The agent's workspace path, its identity anchor.
   * @returns A filesystem-safe, per-agent-stable directory name.
   */
  static slugFor(agentName: string, agentPath: string): string {
    const name = slugifyAgentName(agentName).slice(0, SLUG_NAME_CHARS).replace(/-+$/, '');
    return `${name || 'agent'}-${RoomWorktreeManager.digestFor(agentPath)}`;
  }

  /**
   * The identity half of a worktree name — the part that survives a rename.
   *
   * Its own method because the reap needs it without the agent's NAME: it holds
   * directory names and a set of busy agent paths, and matching on this suffix
   * is the only join available between the two.
   *
   * @param agentPath - The agent's workspace path.
   * @returns The digest that ends every worktree name for that agent.
   */
  static digestFor(agentPath: string): string {
    return createHash('sha256')
      .update(path.resolve(agentPath))
      .digest('hex')
      .slice(0, SLUG_DIGEST_CHARS);
  }

  /**
   * Give an agent its standing working copy in this room, making it if it is
   * not there yet.
   *
   * Idempotent: a second call for the same agent returns the same directory,
   * and refreshes its idle clock. The first call branches `room/<slug>` off
   * `main`, checks it out, and runs harness projection in it.
   *
   * **Every resolution stamps the directory** (`utimes`), including the ones
   * that create nothing. That is not bookkeeping, it is the reap's first line
   * of defence: once the cwd rung lands, this method IS how a room turn learns
   * where to run, so a turn that only reads its worktree would otherwise leave
   * no trace on any date source and the sweep would delete the directory it is
   * standing in. Handing out a path is itself evidence of use, so it is
   * recorded as such.
   *
   * **The in-flight map is consulted before anything touches the disk**, so two
   * turns resolving at the same moment share one resolution rather than racing.
   * Reversed — an existence check first — the second caller could look at a
   * directory the first was halfway through creating and hand a turn a path
   * that is not a checkout yet.
   *
   * **A half-made worktree is healed rather than believed.** A directory
   * without a `.git` entry is not a checkout, and returning it forever was a
   * wedge with no way out but manual repair: the reap could not remove it
   * (unreadable trees are stranded by design) and this method kept answering
   * with it. An empty one is cleared and rebuilt; a non-empty one is moved
   * aside as `<slug>.orphaned-<n>` — never deleted, because the reason it has
   * files in it is exactly what nobody here knows — and a fresh worktree is
   * built beside it. The moved directory is not a checkout either, so the reap
   * lists it as stranded work for a person to look at.
   *
   * **Nothing here ever removes a worktree, and neither does leaving the room.**
   * The reap ({@link RoomWorktreeManager.reapRoom}) is the only remover on any
   * surface, and it removes only what is idle, clean, merged and unclaimed. An
   * agent that is thrown out of a room mid-thought still has every unsaved edit
   * when it is let back in — membership decides who is talked to, not who keeps
   * their work (spec §3.4).
   *
   * @param roomId - The room.
   * @param agentPath - The agent's workspace path — its identity anchor, and
   *   what makes the worktree name collision-safe.
   * @param agentName - The agent's display name, for the readable half of the
   *   directory name.
   * @returns Where the agent works, and whether this resolution made it.
   * @throws {RoomError} `NOT_A_PROJECT_ROOM` when the room has no files.
   */
  async ensureWorktree(
    roomId: string,
    agentPath: string,
    agentName: string
  ): Promise<RoomWorktreeHandle> {
    if (!this.deps.hasRepo(roomId)) {
      throw new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files of its own.');
    }

    const slug = RoomWorktreeManager.slugFor(agentName, agentPath);
    const dir = path.join(this.deps.store.worktreesPath(roomId), slug);
    const branch = roomWorktreeBranch(slug);

    // Registered BEFORE the first `await`, so no second caller can slip between
    // the lookup and the insert. Every path — reuse, heal, create — runs inside
    // this one promise.
    const key = `${roomId}/${slug}`;
    const inFlight = this.creating.get(key);
    if (inFlight) return inFlight;
    const resolution = this.resolveWorktree(roomId, dir, slug, branch).finally(() => {
      this.creating.delete(key);
    });
    this.creating.set(key, resolution);
    return resolution;
  }

  /**
   * Reuse the working copy, heal it, or make it — the body of one resolution.
   *
   * @param roomId - The room.
   * @param dir - Where the working copy lives.
   * @param slug - Its directory name.
   * @param branch - The branch it checks out.
   */
  private async resolveWorktree(
    roomId: string,
    dir: string,
    slug: string,
    branch: string
  ): Promise<RoomWorktreeHandle> {
    if (await isCheckout(dir)) {
      // Handing the path out is the use. See `ensureWorktree`'s docs. Stamped
      // from the same clock the reap's cutoff reads, so the two never disagree
      // about what "now" is.
      await stampDirectory(dir, this.nowMs());
      return { slug, path: dir, branch, created: false, projection: null };
    }
    if (await directoryExists(dir)) await this.setCorpseAside(roomId, dir, slug);
    return this.createWorktree(roomId, dir, slug, branch);
  }

  /**
   * Move a directory that is not a checkout out of the way, keeping everything
   * in it.
   *
   * An empty one is simply removed. Anything else is renamed rather than
   * deleted: this runs unattended, and "I do not recognize this directory" has
   * never been a reason to destroy its contents anywhere else in this domain.
   *
   * @param roomId - The room, for the log line.
   * @param dir - The directory in the way.
   * @param slug - Its name, for the log line.
   */
  private async setCorpseAside(roomId: string, dir: string, slug: string): Promise<void> {
    try {
      if ((await fs.readdir(dir)).length === 0) {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      }
    } catch {
      // Unreadable. Fall through to the rename, which needs no listing.
    }
    const moved = `${dir}.orphaned-${Date.now()}`;
    await fs.rename(dir, moved);
    logger.warn('[rooms] a room worktree directory was not a checkout; moved it aside', {
      roomId,
      worktree: slug,
      movedTo: moved,
      note: 'nothing was deleted; the sweep will list it as unfinished work',
    });
  }

  /**
   * What one worktree holds right now.
   *
   * @param roomId - The room.
   * @param slug - The worktree's directory name
   *   ({@link RoomWorktreeManager.slugFor}).
   * @returns The status, or `null` when there is no such worktree.
   * @throws When the directory is there and git cannot read it — the caller
   *   decides what an unreadable tree means, and the reap decides it is work.
   */
  async worktreeStatus(roomId: string, slug: string): Promise<RoomWorktreeStatus | null> {
    const dir = path.join(this.deps.store.worktreesPath(roomId), slug);
    if (!(await directoryExists(dir))) return null;
    const ceiling = this.deps.store.homeDir(roomId);
    // Dated FIRST, for the reason `reapRoom` dates first: `git status` refreshes
    // the index when its stat cache is out of date, and the index is one of the
    // sources below. Asked afterwards, every worktree this method looks at
    // reports "touched just now" — measured, on a tree deliberately aged forty
    // days.
    const lastTouchedAt = (await this.lastTouchedAt(dir, ceiling)).toISOString();
    return {
      slug,
      path: dir,
      dirty: await hasUncommittedChanges(dir, ceiling),
      aheadOfMain: await commitsAheadOfMain(dir, ceiling),
      lastTouchedAt,
    };
  }

  /**
   * Tidy away one room's empty working copies, and report what was kept.
   *
   * Called by `RoomRepoReconciler` so the install has exactly one sweep with
   * one overlap guard; nothing else should call it on a timer.
   *
   * A room whose feature flag is off, or that has no `repo/`, is skipped whole:
   * turning room files off must not become a delete pass.
   *
   * @param roomId - The room to sweep.
   * @returns What was removed, and what was kept and why.
   */
  async reapRoom(roomId: string): Promise<RoomWorktreeSweepResult> {
    const result: RoomWorktreeSweepResult = {
      reaped: [],
      reapedTreeKeptBranch: [],
      spared: [],
      stranded: [],
    };
    if (!this.deps.hasRepo(roomId)) return result;

    const root = this.deps.store.worktreesPath(roomId);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return result;
    }
    const candidates = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (candidates.length === 0) return result;

    const repoDir = this.deps.store.repoPath(roomId);
    const ceiling = this.deps.store.homeDir(roomId);

    // **Dated BEFORE anything else reads these trees, and the order is a fix.**
    // `listStrandedWorktrees` runs `git status` in every candidate, and a status
    // refresh REWRITES that worktree's index — one of the four sources
    // `lastTouchedAt` reads. Asked afterwards, the sweep would be reading a
    // timestamp it had just created: every tree would look touched seconds ago
    // and nothing would ever be reaped. Measured on a tree aged forty days: it
    // survived a sweep at the shipped fourteen-day default. The idle clock must
    // not be able to see the sweep that reads it.
    const dated = new Map<string, Date | null>();
    for (const slug of candidates) {
      try {
        dated.set(slug, await this.lastTouchedAt(path.join(root, slug), ceiling));
      } catch {
        // Unreadable. Recorded as such rather than skipped, so the loop below
        // can be conservative about it without a second probe.
        dated.set(slug, null);
      }
    }

    // **The safety gate, asked once and honoured absolutely.** Everything on
    // this list holds uncommitted edits, unmerged commits, or is a directory
    // git could not read — and none of it is removable at any setting of
    // `worktreeReapDays`. Removing this line is what the module's red-before
    // tests re-introduce.
    const stranded = new Set(await this.deps.listStrandedWorktrees(roomId));
    // Agents that are mid-turn. Their worktree is a live cwd once the cwd rung
    // lands, and a turn that only reads leaves no mark on any date above.
    const busy = new Set(
      this.deps.busyAgentPaths().map((agentPath) => RoomWorktreeManager.digestFor(agentPath))
    );
    const idleCutoff = this.nowMs() - this.deps.reapAfterDays() * 24 * 60 * 60 * 1000;

    for (const slug of candidates) {
      if (stranded.has(slug)) {
        result.stranded.push(slug);
        continue;
      }
      if (busy.has(slug.slice(-SLUG_DIGEST_CHARS))) {
        logger.debug('[rooms] not tidying a room worktree its agent is working in', {
          roomId,
          worktree: slug,
        });
        result.spared.push(slug);
        continue;
      }
      const touched = dated.get(slug) ?? null;
      if (touched === null) {
        // It read as clean a moment ago and could not be dated. Whatever the
        // reason, "I no longer understand this directory" is never a reason to
        // delete it.
        logger.warn('[rooms] could not date a room worktree; leaving it alone', {
          roomId,
          worktree: slug,
        });
        result.stranded.push(slug);
        continue;
      }
      if (touched.getTime() > idleCutoff) {
        result.spared.push(slug);
        continue;
      }

      const dir = path.join(root, slug);
      try {
        // No `--force`: git refuses a tree holding modified or untracked files.
        // A DIFFERENT half of the question from `branch -d` below — see the
        // module doc on why the gates are not interchangeable.
        await removeWorktree(repoDir, dir, ceiling);
      } catch (err) {
        logger.warn('[rooms] git would not remove an idle room worktree; keeping it', {
          roomId,
          worktree: slug,
          err,
        });
        result.spared.push(slug);
        continue;
      }
      // `-d`, never `-D`: git refuses a branch `main` does not contain. When it
      // refuses, the commits are still there and the outcome is reported as
      // what it is rather than folded into `reaped`.
      const branchGone = await deleteMergedBranch(repoDir, roomWorktreeBranch(slug), ceiling);
      if (branchGone) {
        result.reaped.push(slug);
      } else {
        logger.info('[rooms] tidied a room working copy but kept its branch: main has not got it', {
          roomId,
          worktree: slug,
          branch: roomWorktreeBranch(slug),
        });
        result.reapedTreeKeptBranch.push(slug);
      }
    }

    if (result.reaped.length + result.reapedTreeKeptBranch.length > 0) {
      try {
        await pruneWorktrees(repoDir, ceiling);
      } catch (err) {
        logger.warn('[rooms] could not prune the room worktree list', { roomId, err });
      }
    }
    return result;
  }

  /**
   * The most recent moment anything in a worktree moved.
   *
   * **Bounded on purpose, and every source it keeps is one the sweep cannot
   * move.** Three cheap sources are taken, and the newest wins:
   *
   * - the committer date of `HEAD` — when the agent last committed here, and
   *   the floor for a worktree that has done nothing else (a fresh one inherits
   *   `main`'s tip),
   * - the mtime of the working tree's own root directory — moved by anything
   *   created or deleted at the top level, including the `git worktree add`
   *   that made it, so a brand-new worktree reads as touched now,
   * - the newest mtime among the root's direct children.
   *
   * **The `index` mtime is deliberately NOT among them, and that is a fix
   * rather than an omission.** It used to be the fourth source, and it was the
   * one that made the reap load-sensitive: git rewrites its index whenever a
   * read finds the cached `stat` untrustworthy — a plain `git status`, and on a
   * slow filesystem an ordinary read — and that rewrite stamps the index file
   * `now`. Reproduced directly: after a worktree was aged forty days, one
   * index-refreshing git call in this very method read the index back as
   * "touched now", and the reap spared a genuinely idle tree. On a busy CI
   * runner that surfaced as a reap that removed nothing. Dropping the source
   * removes the coupling at the root: the sweep runs `git status` in every
   * candidate (`listStrandedWorktrees`) and this method runs `git log` — none
   * of it moves a directory or a working-file mtime, only the index, which is
   * no longer read.
   *
   * Nothing real is lost with it. The index mtime moves on `git add` (which
   * leaves the tree dirty — the stranded gate catches it), on `commit` (which
   * moves `HEAD` and puts the branch ahead of main — the stranded gate again,
   * and the head date here), and on a bare `git status` (which is a read, not
   * work). The one thing it uniquely marked was "somebody ran `git status`
   * here", which is not a reason to keep a checkout alive.
   *
   * That is one `readdir` and a handful of `stat`s, no matter how large the
   * tree. A full recursive walk would be the complete answer and would also be
   * a disk scan of every agent's checkout every five minutes, on a machine
   * already running the agents.
   *
   * What the bound misses: an edit deep inside an existing top-level directory.
   * For work that matters this costs nothing, because such a tree is dirty by
   * git's own reckoning and the reap never reaches the date. The real residue
   * is a worktree whose only recent activity is writing IGNORED files deep down
   * — build output, `node_modules` under an existing directory. That can be
   * reaped after the idle window, and what is lost is regenerable.
   *
   * @param dir - The worktree.
   * @param ceiling - The room home directory git's search may not climb past.
   * @returns The newest of the three.
   */
  private async lastTouchedAt(dir: string, ceiling: string): Promise<Date> {
    const stamps: number[] = [];

    // The filesystem mtimes first, and the one git spawn last: even though
    // `git log` does not touch a directory or working-file mtime, reading the
    // durable sources before any child process runs keeps this method's answer
    // provably independent of anything git might do.
    const entries = await fs.readdir(dir);
    stamps.push(...(await newestMtime([dir, ...entries.map((name) => path.join(dir, name))])));

    const head = await headCommittedAt(dir, ceiling);
    if (head) stamps.push(head.getTime());

    return new Date(Math.max(...stamps, 0));
  }

  /**
   * Make the worktree, project into it, and report what happened.
   *
   * @param roomId - The room.
   * @param dir - Where the working copy goes.
   * @param slug - Its directory name.
   * @param branch - The branch to check out.
   */
  private async createWorktree(
    roomId: string,
    dir: string,
    slug: string,
    branch: string
  ): Promise<RoomWorktreeHandle> {
    const repoDir = this.deps.store.repoPath(roomId);
    const ceiling = this.deps.store.homeDir(roomId);
    await fs.mkdir(this.deps.store.worktreesPath(roomId), { recursive: true });
    await this.ensureProjectionExcluded(repoDir, ceiling);

    // The branch may outlive its directory: the reap removes the working copy
    // and `git branch -d` can refuse (or never run, if the process died in
    // between). Probing tells "never had one" from "had one, lost the
    // directory"; catching the failure would make every other failure look the
    // same, which is the bug `hasMainBranch` was split out to avoid.
    const branchExists = await hasLocalBranch(repoDir, branch, ceiling);
    // A worktree that was moved aside leaves git's own record of the path
    // behind, and `worktree add` refuses a path it still believes in.
    try {
      await pruneWorktrees(repoDir, ceiling);
    } catch {
      // Nothing to prune, or a repo that cannot be read — `addWorktree` below
      // gives the caller the real error either way.
    }
    await addWorktree(repoDir, dir, branch, branchExists ? null : 'main', ceiling);

    const projection = projectAgentWorkspace(dir);
    logger.info('[rooms] room worktree created', {
      roomId,
      worktree: slug,
      branch,
      projection: projection.status,
      projected: projection.applied,
    });
    return { slug, path: dir, branch, created: true, projection };
  }

  /**
   * Put the projection paths in the repo's shared `info/exclude`, once.
   *
   * Written to the COMMON git directory, so one write covers `repo/` and every
   * worktree — git resolves `info/` to the common directory even from a linked
   * worktree. Idempotent by marker, and best-effort: a repo whose git directory
   * cannot be written is a repo whose worktrees read dirty, which is the
   * conservative failure (spared, never deleted) rather than a reason to refuse
   * an agent its working copy.
   *
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   */
  private async ensureProjectionExcluded(repoDir: string, ceiling: string): Promise<void> {
    try {
      const infoDir = path.join(await commonGitDir(repoDir, ceiling), 'info');
      const file = path.join(infoDir, 'exclude');
      let current = '';
      try {
        current = await fs.readFile(file, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
      if (current.includes(EXCLUDE_MARKER)) return;
      await fs.mkdir(infoDir, { recursive: true });
      const separator = current === '' || current.endsWith('\n') ? '' : '\n';
      await fs.writeFile(file, `${current}${separator}${EXCLUDE_BLOCK}\n`, 'utf-8');
    } catch (err) {
      logger.warn('[rooms] could not hide harness projection from a room repo’s git status', {
        repoDir,
        err,
      });
    }
  }
}

/** Whether a path is a directory that exists. */
async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a directory is a git checkout, cheaply.
 *
 * A `.git` entry is enough and a git command would be too much: this runs on
 * the turn path, on every cwd resolution. In a linked worktree `.git` is a file
 * naming the real gitdir, so `existsSync` rather than a directory check.
 *
 * @param dir - The directory to inspect.
 */
async function isCheckout(dir: string): Promise<boolean> {
  if (!(await directoryExists(dir))) return false;
  return existsSync(path.join(dir, '.git'));
}

/**
 * Mark a directory as used, as of `nowMs`.
 *
 * `utimes` on the directory itself, which is one of the sources
 * {@link RoomWorktreeManager.lastTouchedAt} reads and the only one a turn that
 * merely READS its worktree would otherwise never move. The time is passed in
 * rather than read here so it is the SAME clock the reap's cutoff uses — a
 * stamp and a cutoff drawn from two clocks could disagree by exactly the margin
 * that decides whether a live turn's directory survives. Best-effort: a stamp
 * that fails costs a tidy-up, and refusing a turn its working directory because
 * a timestamp would not write would cost the turn.
 *
 * @param dir - The directory to stamp.
 * @param nowMs - The moment to record, epoch ms.
 */
async function stampDirectory(dir: string, nowMs: number): Promise<void> {
  const now = new Date(nowMs);
  try {
    await fs.utimes(dir, now, now);
  } catch (err) {
    logger.debug('[rooms] could not refresh a room worktree’s idle clock', { dir, err });
  }
}

/**
 * The mtimes of the paths that exist, in milliseconds.
 *
 * Missing paths contribute nothing rather than throwing: an `index` a worktree
 * has not written yet, and a file removed between the `readdir` and the `stat`,
 * are both ordinary.
 *
 * @param targets - Paths to stat.
 */
async function newestMtime(targets: string[]): Promise<number[]> {
  const stamps: number[] = [];
  for (const target of targets) {
    try {
      stamps.push((await fs.lstat(target)).mtimeMs);
    } catch {
      // Gone, or never there. Not a date.
    }
  }
  return stamps;
}
