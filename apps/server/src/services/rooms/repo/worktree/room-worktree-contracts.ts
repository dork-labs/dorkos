import type { RoomRepoStore } from '../room-repo-store.js';
import type { RoomWorktreeManager } from '../room-worktree-manager.js';

/** One agent's standing working copy in one room. */
export interface RoomWorktreeHandle {
  /** The directory name under `worktrees/`, and the tail of the branch name. */
  slug: string;
  /** Absolute path to the working copy — granted to its agent's room turns. */
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
  /** The room's shared checkout, `<room>/repo`, whose `.git` this copy commits into. */
  repo: string;
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
