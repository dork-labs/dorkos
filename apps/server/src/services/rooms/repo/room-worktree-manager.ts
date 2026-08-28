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
 * ## The reap spares work, and that is the only promise it makes
 *
 * `config.rooms.repo.worktreeReapDays` is filed as a no-risk setting — no value
 * of it can lose work — and the reason is here rather than in the config
 * schema. A worktree is removed only when THREE independent things agree:
 *
 * 1. It is not in {@link RoomWorktreeManagerDeps.listStrandedWorktrees}, which
 *    is the delete guard's own list: anything dirty, anything holding commits
 *    `main` has never seen, and anything git cannot read at all.
 * 2. Nothing in it has been touched inside the idle window.
 * 3. `git worktree remove` — **without `--force`** — agrees to remove it. Git
 *    refuses a working tree holding modified or untracked files, so this is a
 *    second dirty check made by a different program at a later moment than the
 *    first. An agent that started typing between the two is caught by the one
 *    that runs last.
 *
 * Only then is the branch retired, with `git branch -d` and never `-D`, which
 * refuses anything `main` does not already contain. Four gates, of which any
 * one alone would be enough to make the setting safe. The two that matter most
 * are pinned red-before/green-after in this module's tests: remove the stranded
 * check and a dirty worktree is deleted; remove it and a clean-but-unmerged one
 * is deleted too.
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
 * The exclude list holds only what DorkOS generates, never what a member would
 * author, and **an exclude cannot hide a tracked file** — so a room that
 * commits its own `.claude/settings.local.json` keeps working on it normally.
 * The known gap: a repo carrying `.dork/plugins/` also gets generated command
 * wrappers under `.claude/commands/`, which is not excluded because members
 * author there too. Such a worktree reads dirty, which is the conservative
 * direction (spared, never deleted).
 *
 * @module server/services/rooms/repo/room-worktree-manager
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
  absoluteGitDir,
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

/** The branch a room worktree checks out, given its slug. */
export function roomWorktreeBranch(slug: string): string {
  return `room/${slug}`;
}

/**
 * The `info/exclude` block that keeps harness projection out of `git status`.
 *
 * Marker-delimited so the block can be recognized and left alone on the next
 * call rather than appended twice, and so a person reading the file knows what
 * wrote it and why. See the module doc for what is deliberately NOT in it.
 */
const EXCLUDE_BLOCK = [
  '# --- DorkOS: harness projection output, not anybody’s work (room-worktree-manager.ts) ---',
  '/.claude/skills/',
  '/.claude/settings.local.json',
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
  /** Whether THIS call is what created it. */
  created: boolean;
  /**
   * What harness projection did, when this call created the worktree.
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
  /** Worktrees removed: idle past the cap, clean, and merged. */
  reaped: string[];
  /** Worktrees kept because they have been touched inside the idle window. */
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
   * Harness projection for a freshly created worktree.
   *
   * Injected so a test can prove it ran without depending on the engine's
   * output; production passes {@link projectAgentWorkspace}.
   */
  project?: (dir: string) => AgentWorkspaceProjection;
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
    const digest = createHash('sha256')
      .update(path.resolve(agentPath))
      .digest('hex')
      .slice(0, SLUG_DIGEST_CHARS);
    return `${name || 'agent'}-${digest}`;
  }

  /**
   * Give an agent its standing working copy in this room, making it if it is
   * not there yet.
   *
   * Idempotent: a second call for the same agent returns the same directory and
   * touches nothing. The first call branches `room/<slug>` off `main`, checks it
   * out, and runs harness projection in it.
   *
   * **Nothing here ever removes a worktree, and neither does leaving the room.**
   * The reap ({@link RoomWorktreeManager.reapRoom}) is the only remover on any
   * surface, and it removes only what is clean, merged and idle. An agent that
   * is thrown out of a room mid-thought still has every unsaved edit when it is
   * let back in — membership decides who is talked to, not who keeps their work
   * (spec §3.4).
   *
   * @param roomId - The room.
   * @param agentPath - The agent's workspace path — its identity anchor, and
   *   what makes the worktree name collision-safe.
   * @param agentName - The agent's display name, for the readable half of the
   *   directory name.
   * @returns Where the agent works, and whether this call made it.
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

    if (await directoryExists(dir)) {
      return { slug, path: dir, branch, created: false, projection: null };
    }

    const key = `${roomId}/${slug}`;
    const inFlight = this.creating.get(key);
    if (inFlight) return inFlight;

    const creation = this.createWorktree(roomId, dir, slug, branch).finally(() => {
      this.creating.delete(key);
    });
    this.creating.set(key, creation);
    return creation;
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
    return {
      slug,
      path: dir,
      dirty: await hasUncommittedChanges(dir, ceiling),
      aheadOfMain: await commitsAheadOfMain(dir, ceiling),
      lastTouchedAt: (await this.lastTouchedAt(dir, ceiling)).toISOString(),
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
    const result: RoomWorktreeSweepResult = { reaped: [], spared: [], stranded: [] };
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

    // **The safety gate, asked once and honoured absolutely.** Everything on
    // this list holds uncommitted edits, unmerged commits, or is a directory
    // git could not read — and none of it is removable at any setting of
    // `worktreeReapDays`. Removing this line is what the module's two
    // red-before tests re-introduce.
    const stranded = new Set(await this.deps.listStrandedWorktrees(roomId));
    const repoDir = this.deps.store.repoPath(roomId);
    const ceiling = this.deps.store.homeDir(roomId);
    const idleCutoff = Date.now() - this.deps.reapAfterDays() * 24 * 60 * 60 * 1000;

    for (const slug of candidates) {
      if (stranded.has(slug)) {
        result.stranded.push(slug);
        continue;
      }
      const dir = path.join(root, slug);
      let touched: Date;
      try {
        touched = await this.lastTouchedAt(dir, ceiling);
      } catch (err) {
        // It read as clean a moment ago and cannot be read now. Whatever
        // changed, "I no longer understand this directory" is never a reason to
        // delete it.
        logger.warn('[rooms] could not date a room worktree; leaving it alone', {
          roomId,
          worktree: slug,
          err,
        });
        result.stranded.push(slug);
        continue;
      }
      if (touched.getTime() > idleCutoff) {
        result.spared.push(slug);
        continue;
      }

      try {
        // No `--force`: git refuses a tree holding modified or untracked files,
        // which is the second dirty check and the later one. See the module doc.
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
      // `-d`, never `-D`: git refuses a branch `main` does not contain, so even
      // a wrong answer above cannot lose a commit here.
      await deleteMergedBranch(repoDir, roomWorktreeBranch(slug), ceiling);
      result.reaped.push(slug);
    }

    if (result.reaped.length > 0) {
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
   * **Bounded on purpose, and the bound is what it is honest about.** Four
   * cheap sources are taken, and the newest wins:
   *
   * - the committer date of `HEAD` — when the agent last committed here, and
   *   the floor for a worktree that has done nothing else (a fresh one inherits
   *   `main`'s tip),
   * - the mtime of the working tree's own root directory — moved by anything
   *   created or deleted at the top level, including the `git worktree add`
   *   that made it, so a brand-new worktree reads as touched now,
   * - the mtime of that worktree's `index` — moved by every `git add`, commit
   *   and status refresh,
   * - the newest mtime among the root's direct children.
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
   * @returns The newest of the four.
   */
  private async lastTouchedAt(dir: string, ceiling: string): Promise<Date> {
    const stamps: number[] = [];

    const head = await headCommittedAt(dir, ceiling);
    if (head) stamps.push(head.getTime());

    const gitDir = await absoluteGitDir(dir, ceiling);
    stamps.push(...(await newestMtime([path.join(gitDir, 'index')])));

    const entries = await fs.readdir(dir);
    stamps.push(...(await newestMtime([dir, ...entries.map((name) => path.join(dir, name))])));

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
    await addWorktree(repoDir, dir, branch, branchExists ? null : 'main', ceiling);

    const project = this.deps.project ?? projectAgentWorkspace;
    const projection = project(dir);
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
