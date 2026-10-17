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
 *    A room turn stands in its agent's home but is granted this directory and
 *    works on it by path (spec `agent-home-desk` §5.1), and a turn that is only
 *    reading — think, then write — leaves no mark any date source below can
 *    see. Deleting the copy out from under a live turn is the one way this
 *    sweep could break something that was not even idle.
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
 * ## What DorkOS used to write in here, and how it leaves
 *
 * From DOR-1597 until spec `agent-home-desk`, a room turn STOOD in this tree,
 * so DorkOS wrote into it what a turn's directory needs: the Operating DorkOS
 * skill pack (`.agents/skills/<name>/SKILL.md`, DOR-1640), harness projection
 * links (`.claude/skills/*`, `.agents/harness.manifest.json`, a scaffolded
 * `.claude/CLAUDE.md`, installed-package links `.agents/skills/<pkg>__<name>`)
 * and projected attachments (`.dork/.temp/room-attachments/`). All of it was
 * hidden from `git status` by a marker block in the repo's shared
 * `info/exclude`, so the tree read clean.
 *
 * A turn now stands in its agent's home, where the pack and the projection
 * already are, and attachments land there too. Nothing is written into a new
 * worktree any more. What older ones hold is retired by
 * {@link RoomWorktreeManager.retireLegacyPlumbing}, once per worktree per
 * process, at the worktree's next turn launch and never while a turn on that
 * (room, agent) is running. It deletes only what DorkOS provably wrote — an
 * unmodified seeded skill, a link into the pack or the agent's home, the
 * scaffolds byte for byte, and the attachment folder, which is DorkOS's and
 * rebuildable — and leaves anything else at those paths alone, because it is
 * somebody's own file. The marker block is removed only when no worktree of
 * the repo still holds an untracked file it hides; until then it stays, frozen
 * at its last contents, because removing it would make every such worktree
 * read dirty — never reaped, and every merge refused `UNCOMMITTED_WORK`.
 *
 * @module server/services/rooms/repo/room-worktree-manager
 */
import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { RoomContextFiles } from '@dorkos/shared/additional-context';
import { slugifyAgentName } from '@dorkos/shared/validation';
import { isUnmodifiedSeededSkill, OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';
import { CLAUDE_INSTRUCTION_CONTENT } from '@dorkos/harness';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../data/room-errors.js';
import { PROJECTED_ATTACHMENTS_ROOT } from '../attachments/attachment-paths.js';
import { AGENT_WORKSPACE_HARNESSES } from '../../harness/project-agent-workspace.js';
import type { RoomRepoStore } from './room-repo-store.js';
import type { RoomWorktreeRefreshTarget } from './room-worktree-refresh.js';
import {
  addWorktree,
  aheadBehind,
  commitsAheadOfMain,
  commonGitDir,
  deleteMergedBranch,
  hasLocalBranch,
  hasUncommittedChanges,
  headCommittedAt,
  pruneWorktrees,
  removeWorktree,
  roomHiddenUntrackedRaw,
  readRoomWorktreeRegistration,
} from './room-repo-git.js';

import type { Db } from '@dorkos/db';
import type { RoomStore } from '../room-store.js';
import {
  requireRoomServiceFileWriteOwner,
  readRoomServiceOriginalBusyAgents,
  type RoomService,
} from '../room-service.js';
import { readOriginalRoomRunnerLaunch } from '../room-turn-runner.js';
import { readOriginalRoomTriggerLaunch } from '../room-trigger.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import { roomTurnGrants, type RoomTurnLaunch, type RoomTurnPlace } from './room-turn-place.js';
import { readOriginalRoomPlacementFacts } from '../service/room-core.js';
import type { DocChannelStore } from '../../canvas/doc-channel/store.js';
import {
  requireInstallationFileWritesOwner,
  type InstallationFileWrites,
} from '../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  requireInstallationRoomWrites,
  readInstallationRoomFileWriteOwner,
  withRecognizedInstallationRoomNamespace,
  readInstallationRoomPlacementMutationContext,
  readInstallationRoomLaunchMutationContext,
  readInstallationRoomMutationRoots,
  readInstallationRoomStoreRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  requireInstallationRoomLaunchTarget,
  type InstallationRoomWrites,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';
import {
  ROOM_REPO_SIDECAR_FILENAME,
  readOwnedRoomRepoSource,
  originalRoomRepoRoomExists,
  executeOriginalRoomRepoStoreRead,
} from './room-repo-store.js';
import { readOriginalRoomRepoMaintenanceOperation } from './room-repo-reconciler.js';
import { readRoomRepoConfig } from './room-repo-config.js';
import { DocChannelNotFoundError } from '../../canvas/doc-channel/authorization.js';
import {
  requireOriginalHttpRoomWorktreeOwner,
  requireOriginalHttpRoomWorktreeAdmission,
} from '../../canvas/doc-channel/http-composition.js';

interface RoomWorktreeOwningConstruction {
  readonly owner: InstallationFileWrites;
  readonly writer: InstallationRoomWrites;
  readonly mutex: RoomRepoMutex;
  readonly db: Db;
  readonly channels: DocChannelStore;
  readonly rooms: RoomService;
  readonly roomStore: RoomStore;
}
const originalWorktreeManagers = new WeakMap<
  RoomWorktreeManager,
  {
    owning: RoomWorktreeOwningConstruction;
    store: RoomRepoStore;
    placement(token: object): Promise<RoomTurnPlace>;
    launch(request: RoomTurnRequest): Promise<RoomTurnLaunch>;
    retire(
      roomId: string,
      worktree: string,
      agentPath: string,
      context: InstallationRoomMutationContext
    ): Promise<{ removed: number; blockRemoved: boolean }>;
    reap(
      roomId: string,
      context: InstallationRoomMutationContext
    ): Promise<RoomWorktreeSweepResult>;
  }
>();
const originalReapContexts = new WeakSet<object>();
const originalReapEffects = new WeakMap<object, () => void>();
/** Fixed last native-entry guard for an actual private maintenance effect window. */
export function requireOriginalRoomWorktreeReapEffect(
  context: InstallationRoomMutationContext
): undefined {
  if (!originalReapContexts.has(context)) return undefined;
  const guard = originalReapEffects.get(context);
  if (!guard) throw new DocChannelNotFoundError();
  guard();
  return undefined;
}
/** Actual reconciler operation remains under its original active namespace throughout reap. */
export function executeOriginalRoomWorktreeReap(
  manager: RoomWorktreeManager,
  roomId: string,
  context: InstallationRoomMutationContext
): Promise<RoomWorktreeSweepResult> {
  const binding = originalWorktreeManagers.get(manager);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  requireRoomWorktreeManagerOwner(
    manager,
    binding.owning.owner,
    binding.owning.db,
    binding.owning.rooms
  );
  requireOriginalHttpRoomWorktreeOwner(
    binding.owning.owner,
    manager,
    binding.owning.db,
    binding.owning.rooms
  );
  const operation = readOriginalRoomRepoMaintenanceOperation(
    context,
    binding.store,
    binding.owning.db
  );
  if (!operation || operation.roomId !== roomId || operation.phase !== 'reap')
    throw new DocChannelNotFoundError();
  return binding.reap(roomId, context);
}
/** Constructor custody only; HTTP composition additionally captures the exact one production instance. */
export function requireRoomWorktreeManagerOwner(
  manager: RoomWorktreeManager,
  owner: InstallationFileWrites,
  db: Db,
  rooms: RoomService
): undefined {
  const binding = originalWorktreeManagers.get(manager);
  if (
    !binding ||
    binding.owning.owner !== owner ||
    binding.owning.db !== db ||
    binding.owning.rooms !== rooms
  )
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, db, binding.owning.channels);
  requireInstallationRoomWrites(
    binding.owning.writer,
    owner,
    db,
    binding.owning.channels,
    binding.store
  );
  if (
    readInstallationRoomFileWriteOwner(
      binding.owning.writer,
      binding.store,
      binding.owning.mutex
    ) !== owner
  )
    throw new DocChannelNotFoundError();
  requireRoomServiceFileWriteOwner(rooms, db, binding.owning.roomStore);
  return undefined;
}
/** Place a worktree through the original Room worktree manager operation. */
export function executeOriginalRoomWorktreePlacement(
  manager: RoomWorktreeManager,
  token: object
): Promise<RoomTurnPlace> {
  const binding = originalWorktreeManagers.get(manager);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  requireRoomWorktreeManagerOwner(
    manager,
    binding.owning.owner,
    binding.owning.db,
    binding.owning.rooms
  );
  requireOriginalHttpRoomWorktreeAdmission(
    binding.owning.owner,
    manager,
    binding.owning.db,
    binding.owning.rooms
  );
  return binding.placement(token);
}

/** Fixed constructor operation: a copied request or another genuine Manager cannot enter this launch. */
export function executeOriginalRoomWorktreeLaunch(
  manager: RoomWorktreeManager,
  request: RoomTurnRequest
): Promise<RoomTurnLaunch> {
  const binding = originalWorktreeManagers.get(manager);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  requireRoomWorktreeManagerOwner(
    manager,
    binding.owning.owner,
    binding.owning.db,
    binding.owning.rooms
  );
  requireOriginalHttpRoomWorktreeAdmission(
    binding.owning.owner,
    manager,
    binding.owning.db,
    binding.owning.rooms
  );
  return binding.launch(request);
}

/** Fixed finite retirement operation backed by the constructor-private launch target. */
export function executeOriginalRoomWorktreeRetirement(
  manager: RoomWorktreeManager,
  roomId: string,
  worktree: string,
  agentPath: string,
  context: InstallationRoomMutationContext
) {
  const binding = originalWorktreeManagers.get(manager);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  requireRoomWorktreeManagerOwner(
    manager,
    binding.owning.owner,
    binding.owning.db,
    binding.owning.rooms
  );
  requireOriginalHttpRoomWorktreeOwner(
    binding.owning.owner,
    manager,
    binding.owning.db,
    binding.owning.rooms
  );
  requireInstallationRoomLaunchTarget(context, manager, roomId, worktree, agentPath);
  return binding.retire(roomId, worktree, agentPath, context);
}

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
 * Where DorkOS used to project a room's attachments inside a worktree, when a
 * room turn stood in it — derived from the projector's constant rather than
 * spelled a second time. Always DorkOS's, always rebuildable, so
 * {@link RoomWorktreeManager.retireLegacyPlumbing} removes it outright.
 */
const LEGACY_ATTACHMENTS_DIR = PROJECTED_ATTACHMENTS_ROOT;

/**
 * How the marker block in `info/exclude` is recognized — a version-free
 * sentinel, never the marker line itself, because the opening line's prose was
 * edited across releases and a block written by any of them must be found.
 */
const EXCLUDE_SENTINEL = '# --- DorkOS:';

/** The line that closes the block. */
const EXCLUDE_END = '# --- end DorkOS ---';

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
   * Worktrees whose legacy plumbing this process has already retired, keyed by
   * directory — once per worktree per process (spec `agent-home-desk` §5.9).
   * Nothing re-creates what was retired, so asking again could only find a
   * person's own files, which are left alone anyway.
   */
  readonly #retired = new Set<string>();

  /**
   * Bind the manager to one install's store and settings.
   *
   * @param deps - The seams above.
   */
  readonly #deps: Readonly<RoomWorktreeManagerDeps>;
  readonly #owning?: RoomWorktreeOwningConstruction;
  constructor(deps: RoomWorktreeManagerDeps, owning?: RoomWorktreeOwningConstruction) {
    this.#deps = Object.freeze({ ...deps });
    if (owning) {
      requireInstallationFileWritesOwner(owning.owner, owning.db, owning.channels);
      requireInstallationRoomWrites(
        owning.writer,
        owning.owner,
        owning.db,
        owning.channels,
        deps.store
      );
      if (
        readInstallationRoomFileWriteOwner(owning.writer, deps.store, owning.mutex) !== owning.owner
      )
        throw new DocChannelNotFoundError();
      requireRoomServiceFileWriteOwner(owning.rooms, owning.db, owning.roomStore);
      this.#owning = Object.freeze({ ...owning });
      originalWorktreeManagers.set(
        this,
        Object.freeze({
          owning: this.#owning,
          store: deps.store,
          placement: (token: object) => this.#executePlacement(token),
          launch: (request: RoomTurnRequest) => this.#executeLaunch(request),
          retire: (
            roomId: string,
            worktree: string,
            agentPath: string,
            context: InstallationRoomMutationContext
          ) => this.#retireOwned(roomId, worktree, agentPath, context),
          reap: (roomId: string, context: InstallationRoomMutationContext) =>
            this.#reapOwned(roomId, context),
        })
      );
    }
  }

  /** Epoch ms from the injected clock, or the wall clock. */
  #nowMs(): number {
    return (this.#deps.now ?? Date.now)();
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
   * `main` and checks it out; nothing else is written into it.
   *
   * **Every resolution stamps the directory** (`utimes`), including the ones
   * that create nothing. That is not bookkeeping, it is the reap's first line
   * of defence: every room turn in a room with files is placed through this
   * method (`room-turn-place.ts`), so a turn that only reads its worktree would
   * otherwise leave no trace on any date source and the sweep would delete the
   * copy it is working on. Handing out a path is itself evidence of use, so it is
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
    void roomId;
    void agentPath;
    void agentName;
    throw new DocChannelNotFoundError();
  }

  async #executePlacement(token: object): Promise<RoomTurnPlace> {
    const owning = this.#owning!;
    requireOriginalHttpRoomWorktreeOwner(owning.owner, this, owning.db, owning.rooms);
    const facts = readOriginalRoomPlacementFacts(token, owning.db, owning.roomStore);
    if (!facts) throw new DocChannelNotFoundError();
    const enabled = readRoomRepoConfig().enabled;
    const source = readOwnedRoomRepoSource(this.#deps.store, owning.db, facts.roomId);
    if (
      JSON.stringify(readOriginalRoomPlacementFacts(token, owning.db, owning.roomStore)) !==
      JSON.stringify(facts)
    )
      throw new DocChannelNotFoundError();
    if (!enabled || !source.row)
      throw new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files of its own.');
    return withRecognizedInstallationRoomNamespace(owning.writer, facts.roomId, async (scope) => {
      requireOriginalHttpRoomWorktreeOwner(owning.owner, this, owning.db, owning.rooms);
      const current = readOriginalRoomPlacementFacts(token, owning.db, owning.roomStore);
      if (!current || JSON.stringify(current) !== JSON.stringify(facts))
        throw new DocChannelNotFoundError();
      const context = readInstallationRoomPlacementMutationContext(
        owning.writer,
        facts.roomId,
        scope,
        token,
        owning.roomStore
      );
      const roots = readInstallationRoomMutationRoots(context);
      try {
        const slug = RoomWorktreeManager.slugFor(current.displayName, current.targetAgentPath),
          branch = roomWorktreeBranch(slug);
        const dir = path.join(roots.homePath, 'worktrees', slug);
        const worktree = await this.#resolveWorktree(facts.roomId, dir, slug, branch, context);
        // This retained turn-placement duty remains inside the same original namespace,
        // rather than reopening an unowned pathname after returning the worktree DTO.
        await this.#ensureRoomBranchLogs(context);
        const place = { worktreePath: worktree.path, branch, repoPath: roots.repoPath };
        let counts: { ahead: number | null; behind: number | null };
        try {
          await checkInstallationRoomMutationTarget(context, roots.repoPath);
          counts = await aheadBehind(roots.repoPath, 'main', branch, roots.homePath);
        } catch (error) {
          // An unavailable observation may omit counts; lost original authority
          // must still refuse, including when the Git observation itself failed.
          await checkInstallationRoomMutationTarget(context, roots.repoPath);
          counts = { ahead: null, behind: null };
          logger.debug('[rooms] could not measure a room worktree against main', {
            roomId: facts.roomId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await checkInstallationRoomMutationTarget(context, worktree.path);
        const storeRoots = readInstallationRoomStoreRoots(context, this.#deps.store, owning.db);
        const homeIdentity = await fs.lstat(roots.homePath),
          canonicalHome = await fs.realpath(roots.homePath);
        await checkInstallationRoomMutationTarget(context, worktree.path);
        if (
          !homeIdentity.isDirectory() ||
          homeIdentity.isSymbolicLink() ||
          canonicalHome !==
            path.join(
              storeRoots.canonicalInstallation,
              path.relative(storeRoots.installation, roots.homePath)
            )
        )
          throw new Error('Room grant home is not its original canonical namespace.');
        const additionalDirectories = roomTurnGrants(
          worktree.path,
          roots.repoPath,
          current.targetAgentPath
        );
        for (const grant of additionalDirectories) {
          const relative = path.relative(canonicalHome, grant.path);
          if (
            relative === '..' ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            throw new Error('Room grant resolved outside its original canonical home.');
        }
        await checkInstallationRoomMutationTarget(context, worktree.path);
        if (
          !sameWorktreeInode(homeIdentity, await fs.lstat(roots.homePath)) ||
          (await fs.realpath(roots.homePath)) !== canonicalHome
        )
          throw new Error('Room grant home replaced during projection.');
        // The native filesystem observations above are awaits. Recheck the
        // original request credential and placement before returning grants.
        await checkInstallationRoomMutationTarget(context, worktree.path);
        requireInstallationRoomMutationTarget(context, worktree.path);
        requireInstallationRoomMutationTarget(context, roots.repoPath);
        return {
          cwd: current.targetAgentPath,
          additionalDirectories,
          worktree: worktree.path,
          files: { ...place, ...counts },
        };
      } catch (error) {
        if (error instanceof DocChannelNotFoundError) throw error;
        // Preserve ordinary unavailable-files behavior only while the exact
        // original placement and scope still pass their live guards. Admission,
        // native/currentness, and root failures cannot authorize a fallback.
        await checkInstallationRoomMutationTarget(context, roots.repoPath);
        requireInstallationRoomMutationTarget(context, roots.repoPath);
        logger.warn(
          '[rooms] could not open this agent’s copy of the room’s files; answering without it',
          {
            roomId: facts.roomId,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        requireInstallationRoomMutationTarget(context, roots.repoPath);
        return {
          cwd: current.targetAgentPath,
          additionalDirectories: [],
          worktree: null,
          files: null,
        };
      }
    });
  }

  async #executeLaunch(request: RoomTurnRequest): Promise<RoomTurnLaunch> {
    const owning = this.#owning!;
    requireOriginalHttpRoomWorktreeOwner(owning.owner, this, owning.db, owning.rooms);
    const launch = readOriginalRoomRunnerLaunch(request),
      input = launch && readOriginalRoomTriggerLaunch(request, launch.runner);
    if (!launch || !input || input.manager !== this) throw new DocChannelNotFoundError();
    if (!readOwnedRoomRepoSource(this.#deps.store, owning.db, input.roomId).row)
      throw new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files of its own.');
    return withRecognizedInstallationRoomNamespace(owning.writer, input.roomId, async (scope) => {
      const context = readInstallationRoomLaunchMutationContext(
        owning.writer,
        input.roomId,
        scope,
        request,
        this,
        owning.rooms,
        owning.roomStore
      );
      const roots = readInstallationRoomMutationRoots(context),
        worktrees = path.join(roots.homePath, 'worktrees');
      if (path.dirname(input.worktree) !== worktrees || input.worktree === worktrees)
        throw new DocChannelNotFoundError();
      await checkInstallationRoomMutationTarget(context, input.worktree);
      const result = await input.run(context, launch.sessionId);
      await checkInstallationRoomMutationTarget(context, input.worktree);
      requireInstallationRoomMutationTarget(context, input.worktree);
      return result;
    });
  }

  /**
   * Everything the turn-start refresh needs to find a copy's git (spec
   * `agent-home-desk` §6.1): the copy, the room's shared checkout, the room home
   * the git pin and ceiling hang off, and the copy's own branch — all from the
   * room's layout, never from anything written inside the copy.
   *
   * @param roomId - The room.
   * @param worktree - The copy, as {@link ensureWorktree} returned it.
   * @returns The target, or `null` when the room id names no directory.
   */
  refreshTarget(roomId: string, worktree: string): RoomWorktreeRefreshTarget | null {
    try {
      return {
        worktree,
        repo: this.#deps.store.repoPath(roomId),
        ceiling: this.#deps.store.homeDir(roomId),
        branch: roomWorktreeBranch(path.basename(worktree)),
      };
    } catch {
      return null;
    }
  }

  /**
   * Where `agentPath`'s working copy in this room lives, whether or not it
   * exists yet. Pure — creates, stamps and records nothing.
   *
   * @param roomId - The room.
   * @param agentPath - The agent's workspace path.
   * @param agentName - The agent's display name.
   */
  pathFor(roomId: string, agentPath: string, agentName: string): string {
    return path.join(
      this.#deps.store.worktreesPath(roomId),
      RoomWorktreeManager.slugFor(agentName, agentPath)
    );
  }

  /**
   * Reuse the working copy, heal it, or make it — the body of one resolution.
   *
   * @param roomId - The room.
   * @param dir - Where the working copy lives.
   * @param slug - Its directory name.
   * @param branch - The branch it checks out.
   */
  async #resolveWorktree(
    roomId: string,
    dir: string,
    slug: string,
    branch: string,
    context: InstallationRoomMutationContext
  ): Promise<RoomWorktreeHandle> {
    if (await isCheckout(dir)) {
      // Handing the path out is the use. See `ensureWorktree`'s docs. Stamped
      // from the same clock the reap's cutoff reads, so the two never disagree
      // about what "now" is.
      await this.#stampOwnedDirectory(dir, context);
      requireInstallationRoomMutationTarget(context, dir);
      return {
        slug,
        path: dir,
        branch,
        created: false,
        repo: readInstallationRoomMutationRoots(context).repoPath,
      };
    }
    if (await directoryExists(dir)) await this.#setCorpseAside(roomId, dir, slug, context);
    return this.#createWorktree(roomId, dir, slug, branch, context);
  }

  async #ensureRoomBranchLogs(context: InstallationRoomMutationContext): Promise<void> {
    const { repoPath } = readInstallationRoomMutationRoots(context);
    await checkInstallationRoomMutationTarget(context, repoPath);
    const repo = await fs.lstat(repoPath),
      canonicalRepo = await fs.realpath(repoPath);
    if (!repo.isDirectory() || repo.isSymbolicLink())
      throw new Error('Room branch logs lost their actual repository.');
    let parentPath = repoPath,
      parent = repo;
    for (const segment of ['.git', 'logs', 'refs', 'heads', 'room']) {
      const directory = path.join(parentPath, segment);
      await checkInstallationRoomMutationTarget(context, directory);
      let previous: Stats | undefined;
      try {
        previous = await fs.lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      if (previous && (!previous.isDirectory() || previous.isSymbolicLink()))
        throw new Error('Room branch log directory is not its actual directory.');
      if (
        !sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
        !sameWorktreeInode(repo, await fs.lstat(repoPath))
      )
        throw new Error('Room branch log parent replaced before acquisition.');
      requireInstallationRoomMutationTarget(context, directory);
      if (!previous) await fs.mkdir(directory);
      const current = await fs.lstat(directory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        (previous && !sameWorktreeInode(previous, current)) ||
        (await fs.realpath(directory)) !==
          path.join(canonicalRepo, path.relative(repoPath, directory)) ||
        !sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
        !sameWorktreeInode(repo, await fs.lstat(repoPath))
      )
        throw new Error('Room branch logs refuse a replaced directory/parent.');
      requireInstallationRoomMutationTarget(context, directory);
      parentPath = directory;
      parent = current;
    }
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
  async #setCorpseAside(
    roomId: string,
    dir: string,
    slug: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    const parentPath = path.dirname(dir);
    await checkInstallationRoomMutationTarget(context, dir);
    const parent = await fs.lstat(parentPath),
      original = await fs.lstat(dir);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      !original.isDirectory() ||
      original.isSymbolicLink()
    )
      throw new Error('Room worktree repair lost its actual directory.');
    const empty = (await fs.readdir(dir)).length === 0;
    await checkInstallationRoomMutationTarget(context, dir);
    if (
      !sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
      !sameWorktreeInode(original, await fs.lstat(dir))
    )
      throw new Error('Room worktree repair directory replaced.');
    if (empty) {
      requireInstallationRoomMutationTarget(context, dir);
      await fs.rmdir(dir); // only the observed empty directory, never a recursive foreign tree
      await checkInstallationRoomMutationTarget(context, dir);
      return;
    }
    const moved = `${dir}.orphaned-${Date.now()}`;
    await checkInstallationRoomMutationTarget(context, moved);
    requireInstallationRoomMutationTarget(context, moved);
    await fs.mkdir(moved); // reserve destination rather than overwrite somebody else's path
    const reservation = await fs.lstat(moved);
    let failed = false,
      cause: unknown,
      published = false;
    // Join this scope to its captured cleanup before returning or reporting failure.
    const drainOriginalCleanup = async () => {
      if (!published) {
        try {
          if (
            !sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
            !sameWorktreeInode(reservation, await fs.lstat(moved))
          )
            throw new Error('Room worktree cleanup refuses a foreign reservation.');
          // Cleanup of this actual empty reservation only; admitted namespace remains held.
          await fs.rmdir(moved);
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
      }
    };
    try {
      await checkInstallationRoomMutationTarget(context, dir);
      if (
        !reservation.isDirectory() ||
        reservation.isSymbolicLink() ||
        !sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
        !sameWorktreeInode(original, await fs.lstat(dir)) ||
        !sameWorktreeInode(reservation, await fs.lstat(moved))
      )
        throw new Error('Room worktree move lost its original source/reserved destination.');
      requireInstallationRoomMutationTarget(context, dir);
      requireInstallationRoomMutationTarget(context, moved);
      await fs.rename(dir, moved);
      published = true;
      await checkInstallationRoomMutationTarget(context, moved);
      if (
        !sameWorktreeInode(parent, await fs.lstat(parentPath)) ||
        !sameWorktreeInode(original, await fs.lstat(moved))
      )
        throw new Error('Room orphan move readback changed.');
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
      await drainOriginalCleanup();
    }
    if (failed) throw cause;
    logger.warn('[rooms] a room worktree directory was not a checkout; moved it aside', {
      roomId,
      worktree: slug,
      movedTo: moved,
      note: 'nothing was deleted; the sweep will list it as unfinished work',
    });
  }

  async #stampOwnedDirectory(dir: string, context: InstallationRoomMutationContext): Promise<void> {
    const now = new Date(this.#nowMs());
    await checkInstallationRoomMutationTarget(context, dir);
    const original = await fs.lstat(dir);
    if (!original.isDirectory() || original.isSymbolicLink())
      throw new Error('Room worktree stamp requires the actual directory.');
    let file: import('node:fs/promises').FileHandle | undefined;
    let failed = false,
      cause: unknown;
    try {
      requireInstallationRoomMutationTarget(context, dir);
      file = await fs.open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
      const acquired = await file.stat();
      await checkInstallationRoomMutationTarget(context, dir);
      if (
        !acquired.isDirectory() ||
        !sameWorktreeInode(original, acquired) ||
        !sameWorktreeInode(acquired, await fs.lstat(dir))
      )
        throw new Error('Room worktree stamp directory replaced.');
      requireInstallationRoomMutationTarget(context, dir);
      await file.utimes(now, now);
      await checkInstallationRoomMutationTarget(context, dir);
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
      if (file) {
        try {
          await file.close();
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
      }
    }
    if (failed) throw cause;
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
    const dir = path.join(this.#deps.store.worktreesPath(roomId), slug);
    if (!(await directoryExists(dir))) return null;
    const ceiling = this.#deps.store.homeDir(roomId);
    // Dated FIRST, for the reason `reapRoom` dates first: `git status` refreshes
    // the index when its stat cache is out of date, and the index is one of the
    // sources below. Asked afterwards, every worktree this method looks at
    // reports "touched just now" — measured, on a tree deliberately aged forty
    // days.
    const lastTouchedAt = (await this.#lastTouchedAt(dir, ceiling)).toISOString();
    return {
      slug,
      path: dir,
      dirty: await hasUncommittedChanges(dir, ceiling),
      aheadOfMain: await commitsAheadOfMain(dir, ceiling),
      lastTouchedAt,
    };
  }

  /**
   * What one agent's turn should be TOLD about this room's files (spec §3.7).
   *
   * **One git command, and that is the whole budget.** This runs on every room
   * turn in a project room, ahead of a person waiting for an answer, so it asks
   * the one question the agent has to act on — how far its branch and the room
   * have drifted — and nothing else. `dirty` is deliberately absent: the agent
   * works in that copy and can see its own uncommitted changes,
   * where it cannot see what somebody else merged into `main` while it was away.
   *
   * **Asked in the ROOM's own checkout**, never in the worktree, for the reason
   * {@link aheadBehind} states: a status read must not enter a tree another
   * process owns.
   *
   * **Never a reason for a turn to fail, and it DEGRADES rather than
   * disappearing.** Git missing, no `main` yet, a branch that does not exist
   * because this agent has never worked here: none of those is a reason to stop
   * telling an agent where its copy is and that the room's own copy
   * is not its to write in. Those three facts need no git at all — the paths are
   * derived and the branch name is a pure function of the agent's identity — so
   * only the counts go `null`, and the rendered block simply says nothing about
   * drift. Nulling the whole section instead would drop the one-writer
   * prohibition exactly when the repo is already in a state nobody understands.
   *
   * `null` is returned only when the room has no files at all, or when its own
   * home directory cannot be named — at which point there is genuinely nothing
   * true to say.
   *
   * @param roomId - The room being answered.
   * @param agentPath - The agent's workspace path, its identity anchor.
   * @param agentName - The agent's display name, the readable half of the slug.
   * @param worktreePath - The agent's copy, which the caller already holds.
   *   Passed in rather than rebuilt so the section names exactly the folder the
   *   turn is granted.
   * @returns What to tell the agent, with `null` counts when git could not be
   *   asked, or `null` when there is nothing to tell at all.
   */
  async turnFilesContext(
    roomId: string,
    agentPath: string,
    agentName: string,
    worktreePath: string
  ): Promise<RoomContextFiles | null> {
    if (!this.#deps.hasRepo(roomId)) return null;
    const branch = roomWorktreeBranch(RoomWorktreeManager.slugFor(agentName, agentPath));

    let repoDir: string;
    let ceiling: string;
    try {
      repoDir = this.#deps.store.repoPath(roomId);
      ceiling = this.#deps.store.homeDir(roomId);
    } catch (err) {
      // The room id is not one this store will name a directory for. There is no
      // honest path to print, so there is no section to render.
      logger.debug('[rooms] could not resolve a room repo path for a turn', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const place = { worktreePath, branch, repoPath: repoDir };
    try {
      const { ahead, behind } = await aheadBehind(repoDir, 'main', branch, ceiling);
      return { ...place, behind, ahead };
    } catch (err) {
      logger.debug('[rooms] could not measure a room worktree against main', {
        roomId,
        branch,
        error: err instanceof Error ? err.message : String(err),
      });
      // Where the agent works is still true. Only the drift is unknown, and
      // `null` is how the block is told to say nothing rather than "0".
      return { ...place, behind: null, ahead: null };
    }
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
  async reapRoom(_roomId: string): Promise<RoomWorktreeSweepResult> {
    throw new DocChannelNotFoundError(); // Only the fixed original accepted maintenance operation may mutate.
  }

  async #reapOwned(
    roomId: string,
    context: InstallationRoomMutationContext
  ): Promise<RoomWorktreeSweepResult> {
    const result: RoomWorktreeSweepResult = {
      reaped: [],
      reapedTreeKeptBranch: [],
      spared: [],
      stranded: [],
    };
    const owning = this.#owning!;
    const store = originalWorktreeManagers.get(this)!.store;
    const reapingCapture: { expectedRow?: string } = {};
    const current = () => {
      requireRoomWorktreeManagerOwner(this, owning.owner, owning.db, owning.rooms);
      requireOriginalHttpRoomWorktreeOwner(owning.owner, this, owning.db, owning.rooms);
      const operation = readOriginalRoomRepoMaintenanceOperation(context, store, owning.db);
      if (!operation || operation.roomId !== roomId || operation.phase !== 'reap')
        throw new DocChannelNotFoundError();
      const roots = readInstallationRoomMutationRoots(context);
      const source = readOwnedRoomRepoSource(store, owning.db, roomId);
      if (
        !originalRoomRepoRoomExists(store, owning.db, roomId) ||
        source.row?.mode !== 'owned' ||
        (reapingCapture.expectedRow !== undefined &&
          JSON.stringify(source.row) !== reapingCapture.expectedRow) ||
        roots.homePath !== source.home ||
        roots.repoPath !== source.repo
      )
        throw new DocChannelNotFoundError();
      requireInstallationRoomMutationTarget(context, source.home);
      return roots;
    };
    if (!readRoomRepoConfig().enabled) {
      current();
      return result;
    }
    const roots = current(),
      root = path.join(roots.homePath, 'worktrees');
    reapingCapture.expectedRow = JSON.stringify(
      readOwnedRoomRepoSource(store, owning.db, roomId).row
    );
    originalReapContexts.add(context);
    const sidecar = await executeOriginalRoomRepoStoreRead(store, owning.db, context, roomId);
    current();
    if (!sidecar || sidecar.mode !== 'owned') throw new DocChannelNotFoundError();
    const expectedSidecar = JSON.stringify(sidecar);
    const sidecarPath = path.join(roots.homePath, ROOM_REPO_SIDECAR_FILENAME);
    const homeIdentity = await fs.lstat(roots.homePath);
    current();
    const repoIdentity = await fs.lstat(roots.repoPath);
    current();
    const sidecarIdentity = await fs.lstat(sidecarPath);
    current();
    if (
      !homeIdentity.isDirectory() ||
      homeIdentity.isSymbolicLink() ||
      !repoIdentity.isDirectory() ||
      repoIdentity.isSymbolicLink() ||
      !sidecarIdentity.isFile() ||
      sidecarIdentity.isSymbolicLink()
    )
      throw new DocChannelNotFoundError();
    const same = (left: { dev: number; ino: number }, right: { dev: number; ino: number }) =>
      left.dev === right.dev && left.ino === right.ino;
    let rootIdentity: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      rootIdentity = await fs.lstat(root);
    } catch (error) {
      current();
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return result;
      throw error;
    }
    current();
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink())
      throw new DocChannelNotFoundError();
    await checkInstallationRoomMutationTarget(context, root);
    current();
    const entries = await fs.readdir(root, { withFileTypes: true });
    current();
    const cutoff = this.#nowMs() - readRoomRepoConfig().worktreeReapDays * 24 * 60 * 60 * 1000;
    current();
    const busy = (slug: string) =>
      readRoomServiceOriginalBusyAgents(owning.rooms, owning.db, owning.roomStore).some(
        (agentPath) => RoomWorktreeManager.digestFor(agentPath) === slug.slice(-SLUG_DIGEST_CHARS)
      );
    const verifyParents = async () => {
      current();
      if (!readRoomRepoConfig().enabled) throw new DocChannelNotFoundError();
      await checkInstallationRoomMutationTarget(context, root);
      current();
      for (const [target, expected] of [
        [roots.homePath, homeIdentity],
        [roots.repoPath, repoIdentity],
        [root, rootIdentity],
        [sidecarPath, sidecarIdentity],
      ] as const) {
        const observed = await fs.lstat(target);
        current();
        if (!same(expected, observed) || observed.isSymbolicLink())
          throw new DocChannelNotFoundError();
      }
      const fresh = await executeOriginalRoomRepoStoreRead(store, owning.db, context, roomId);
      current();
      if (!fresh || JSON.stringify(fresh) !== expectedSidecar) throw new DocChannelNotFoundError();
    };
    const nativeTail = (slug?: string, dir?: string, identity?: Stats) => {
      // Callback-free physical checks repeat after the lowlevel launcher's own awaited guards.
      current();
      if (!readRoomRepoConfig().enabled) throw new DocChannelNotFoundError();
      for (const [target, expected] of [
        [roots.homePath, homeIdentity],
        [roots.repoPath, repoIdentity],
        [root, rootIdentity],
        [sidecarPath, sidecarIdentity],
      ] as const) {
        const observed = lstatSync(target);
        if (!same(expected, observed) || observed.isSymbolicLink())
          throw new DocChannelNotFoundError();
        if (
          target === sidecarPath &&
          (observed.size !== sidecarIdentity.size ||
            observed.mtimeMs !== sidecarIdentity.mtimeMs ||
            observed.ctimeMs !== sidecarIdentity.ctimeMs)
        )
          throw new DocChannelNotFoundError();
      }
      if (dir && identity) {
        const observed = lstatSync(dir);
        if (
          !same(identity, observed) ||
          !observed.isDirectory() ||
          observed.isSymbolicLink() ||
          observed.mtimeMs > cutoff
        )
          throw new DocChannelNotFoundError();
      }
      if (slug && busy(slug)) throw new DocChannelNotFoundError();
      current();
    };
    const effect = async <T>(guard: () => void, work: () => Promise<T>): Promise<T> => {
      if (originalReapEffects.has(context)) throw new DocChannelNotFoundError();
      guard();
      originalReapEffects.set(context, guard);
      try {
        return await work();
      } finally {
        originalReapEffects.delete(context);
      }
    };
    const dated = new Map<string, { identity: Stats; date: Date }>();
    // Date every candidate before Git status, preserving the original idle-clock ordering.
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      try {
        await checkInstallationRoomMutationTarget(context, dir);
        current();
        const identity = await fs.lstat(dir);
        current();
        if (!identity.isDirectory() || identity.isSymbolicLink())
          throw new Error('Unknown room worktree directory');
        const date = await this.#lastTouchedAt(dir, roots.homePath);
        current();
        const after = await fs.lstat(dir);
        current();
        if (!same(identity, after)) throw new Error('Room worktree directory was replaced');
        dated.set(entry.name, { identity, date });
      } catch (error) {
        current();
        result.stranded.push(entry.name);
      }
    }
    for (const [slug, candidate] of dated) {
      const dir = path.join(root, slug),
        branch = roomWorktreeBranch(slug);
      if (busy(slug) || candidate.date.getTime() > cutoff) {
        result.spared.push(slug);
        continue;
      }
      let registration: Awaited<ReturnType<typeof readRoomWorktreeRegistration>>;
      try {
        await verifyParents();
        registration = await readRoomWorktreeRegistration(
          roots.repoPath,
          roots.homePath,
          dir,
          branch
        );
        current();
        if (!registration || (await hasUncommittedChanges(dir, roots.homePath))) {
          current();
          result.stranded.push(slug);
          continue;
        }
        current();
        if ((await commitsAheadOfMain(dir, roots.homePath)) > 0) {
          current();
          result.stranded.push(slug);
          continue;
        }
        current();
      } catch (error) {
        current();
        result.stranded.push(slug);
        continue;
      }
      // Repeat actual registration, physical identity, sidecar/native and private busy facts after all waits.
      await verifyParents();
      const finalRegistration = await readRoomWorktreeRegistration(
        roots.repoPath,
        roots.homePath,
        dir,
        branch
      );
      current();
      const finalDirectory = await fs.lstat(dir);
      current();
      if (
        !finalRegistration ||
        JSON.stringify(finalRegistration) !== JSON.stringify(registration) ||
        !same(candidate.identity, finalDirectory) ||
        finalDirectory.isSymbolicLink() ||
        finalDirectory.mtimeMs > cutoff ||
        busy(slug)
      ) {
        result.spared.push(slug);
        continue;
      }
      requireInstallationRoomMutationTarget(context, dir);
      current();
      if (busy(slug)) {
        result.spared.push(slug);
        continue;
      }
      // No force. Git additionally refuses changed files at its actual native removal boundary.
      try {
        await effect(
          () => nativeTail(slug, dir, candidate.identity),
          () => removeWorktree(roots.repoPath, dir, roots.homePath, context)
        );
      } catch (error) {
        current();
        result.spared.push(slug);
        continue;
      }
      current();
      // This successful owned removal is the private continuation receipt for branch cleanup.
      // A fresh claim keeps the branch; never roll back an already-landed worktree removal.
      await verifyParents();
      if (busy(slug)) {
        result.reapedTreeKeptBranch.push(slug);
        continue;
      }
      const branchGone = await effect(
        () => nativeTail(slug),
        () => deleteMergedBranch(roots.repoPath, branch, roots.homePath, context)
      );
      current();
      if (branchGone) result.reaped.push(slug);
      else result.reapedTreeKeptBranch.push(slug);
    }
    if (result.reaped.length + result.reapedTreeKeptBranch.length > 0) {
      await verifyParents();
      await effect(
        () => nativeTail(),
        () => pruneWorktrees(roots.repoPath, roots.homePath, context)
      );
      current();
    }
    current();
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
  async #lastTouchedAt(dir: string, ceiling: string): Promise<Date> {
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
  async #createWorktree(
    roomId: string,
    dir: string,
    slug: string,
    branch: string,
    context: InstallationRoomMutationContext
  ): Promise<RoomWorktreeHandle> {
    const roots = readInstallationRoomMutationRoots(context),
      repoDir = roots.repoPath,
      ceiling = roots.homePath;
    const parentPath = path.join(ceiling, 'worktrees');
    await checkInstallationRoomMutationTarget(context, dir);
    const home = await fs.lstat(ceiling);
    if (!home.isDirectory() || home.isSymbolicLink())
      throw new Error('Room worktree home is not its actual directory.');
    let previousParent: Stats | undefined;
    try {
      previousParent = await fs.lstat(parentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await checkInstallationRoomMutationTarget(context, dir);
    if (!sameWorktreeInode(home, await fs.lstat(ceiling)))
      throw new Error('Room worktree home replaced before parent acquisition.');
    requireInstallationRoomMutationTarget(context, parentPath);
    if (!previousParent) await fs.mkdir(parentPath);
    const parent = await fs.lstat(parentPath);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (previousParent && !sameWorktreeInode(previousParent, parent))
    )
      throw new Error('Room worktree parent replaced.');

    // The branch may outlive its directory: the reap removes the working copy
    // and `git branch -d` can refuse (or never run, if the process died in
    // between). Probing tells "never had one" from "had one, lost the
    // directory"; catching the failure would make every other failure look the
    // same, which is the bug `hasMainBranch` was split out to avoid.
    const branchExists = await hasLocalBranch(repoDir, branch, ceiling);
    // A worktree that was moved aside leaves git's own record of the path
    // behind, and `worktree add` refuses a path it still believes in.
    try {
      await pruneWorktrees(repoDir, ceiling, context);
    } catch {
      // Nothing to prune, or a repo that cannot be read — `addWorktree` below
      // gives the caller the real error either way.
    }
    await checkInstallationRoomMutationTarget(context, dir);
    if (
      !sameWorktreeInode(home, await fs.lstat(ceiling)) ||
      !sameWorktreeInode(parent, await fs.lstat(parentPath))
    )
      throw new Error('Room worktree creation lost its acquired parent.');
    requireInstallationRoomMutationTarget(context, dir);
    await addWorktree(repoDir, dir, branch, branchExists ? null : 'main', ceiling, context);
    await checkInstallationRoomMutationTarget(context, dir);
    if (
      !sameWorktreeInode(home, await fs.lstat(ceiling)) ||
      !sameWorktreeInode(parent, await fs.lstat(parentPath))
    )
      throw new Error('Room worktree creation parent changed after native child.');
    await this.#stampOwnedDirectory(dir, context);
    // Nothing is written into it: the agent's turns stand at home, where its
    // skills and instructions already are (spec `agent-home-desk` §5.8). A new
    // tree is exactly the room's files on the agent's branch.
    this.#retired.add(dir);
    logger.info('[rooms] room worktree created', { roomId, worktree: slug, branch });
    return { slug, path: dir, branch, created: true, repo: repoDir };
  }

  /**
   * Remove what DorkOS wrote into one worktree while room turns stood in it,
   * and the `info/exclude` block that hid it once no worktree of the repo needs
   * it (spec `agent-home-desk` §5.9).
   *
   * Called at the worktree's next room-turn LAUNCH, and only when no turn on
   * that (room, agent) is running — the caller's check, because only the
   * dispatcher can answer it. Once per worktree per process.
   *
   * Only untracked files the block hides are candidates (`git ls-files -o -i`
   * with the block's own lines), and of those only what DorkOS provably wrote
   * is deleted:
   *
   * - a seeded skill whose body still matches the stamp the seeder wrote
   *   (`isUnmodifiedSeededSkill`) — edited, it is somebody's;
   * - a `.claude/skills/*` link, or an installed-package link
   *   `.agents/skills/<pkg>__<name>`, that is a symlink resolving into this
   *   worktree's own `.agents/skills/` or into the agent's home;
   * - `.agents/harness.manifest.json` naming exactly the harnesses DorkOS
   *   scaffolded, and `.claude/CLAUDE.md` holding exactly the pointer DorkOS
   *   scaffolded;
   * - anything under the old attachment folder, always: DorkOS's and
   *   rebuildable.
   *
   * Anything else at those paths is left alone. Never throws: every failure is
   * a log line and the next process tries again.
   *
   * @param roomId - The room.
   * @param worktree - The worktree to tidy, as {@link ensureWorktree} returned it.
   * @param agentPath - Its agent's home, for the link check.
   * @returns How many files were removed, and whether the block was removed.
   */
  async retireLegacyPlumbing(
    _roomId: string,
    _worktree: string,
    _agentPath: string
  ): Promise<{ removed: number; blockRemoved: boolean }> {
    throw new DocChannelNotFoundError();
  }

  async #retireOwned(
    roomId: string,
    worktree: string,
    agentPath: string,
    context: InstallationRoomMutationContext
  ): Promise<{ removed: number; blockRemoved: boolean }> {
    const outcome = { removed: 0, blockRemoved: false };
    const requireLaunch = () =>
      requireInstallationRoomLaunchTarget(context, this, roomId, worktree, agentPath);
    requireLaunch();
    if (this.#retired.has(worktree)) return outcome;
    const roots = readInstallationRoomMutationRoots(context);
    const tree = await fs.lstat(worktree),
      canonicalTree = await fs.realpath(worktree);
    if (
      !tree.isDirectory() ||
      tree.isSymbolicLink() ||
      canonicalTree !==
        path.join(await fs.realpath(roots.homePath), path.relative(roots.homePath, worktree))
    )
      throw new Error('Legacy retirement worktree is not the original native target.');
    const checkTree = async () => {
      await checkInstallationRoomMutationTarget(context, worktree);
      if (
        !sameWorktreeInode(tree, await fs.lstat(worktree)) ||
        (await fs.realpath(worktree)) !== canonicalTree
      )
        throw new Error('Legacy retirement worktree changed.');
      requireLaunch();
    };
    const parentOf = async (target: string) => {
      await checkTree();
      const parent = path.dirname(target),
        stat = await fs.lstat(parent);
      const real = await fs.realpath(parent);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        real !== path.join(canonicalTree, path.relative(worktree, parent))
      )
        throw new Error('Legacy retirement refuses a replaced or linked ancestor.');
      await checkTree();
      return { parent, stat };
    };
    const excludeFile = path.join(
      await commonGitDir(roots.repoPath, roots.homePath),
      'info',
      'exclude'
    );
    await checkTree();
    const patterns = blockPatterns(await readIfPresent(excludeFile));
    await checkTree();
    if (patterns.length === 0) {
      this.#retired.add(worktree);
      return outcome;
    }
    const emptyParents = new Set(LEGACY_PARENT_DIRS);
    for (const rel of await hiddenUntracked(worktree, roots.homePath, patterns)) {
      await checkTree();
      const target = path.resolve(worktree, rel);
      if (target === worktree || !target.startsWith(`${worktree}${path.sep}`))
        throw new Error('Legacy retirement path escaped its original worktree.');
      const parent = await parentOf(target);
      const acquired = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!acquired || (!acquired.isFile() && !acquired.isSymbolicLink())) continue;
      if (!(await isLegacyPlumbing(worktree, rel, agentPath))) continue;
      await checkTree();
      if (
        !sameWorktreeInode(acquired, await fs.lstat(target)) ||
        !sameWorktreeInode(parent.stat, await fs.lstat(parent.parent))
      )
        throw new Error('Legacy retirement refuses an observed replacement.');
      requireLaunch();
      requireInstallationRoomMutationTarget(context, target);
      await fs.unlink(target); // Never recursively delete an observed directory.
      await checkTree();
      outcome.removed++;
      // Only this successfully acquired/unlinked legacy leaf contributes dynamic
      // ancestors (for example attachment entry folders). Never remove content.
      for (
        let ancestor = path.dirname(path.relative(worktree, target));
        ancestor !== '.';
        ancestor = path.dirname(ancestor)
      )
        emptyParents.add(ancestor);
    }
    // Empty ancestor cleanup is identity-checked and never recursively removes content.
    for (const rel of [...emptyParents].sort(
      (left, right) => right.split(path.sep).length - left.split(path.sep).length
    )) {
      const directory = path.join(worktree, rel),
        parent = await parentOf(directory).catch((error: NodeJS.ErrnoException) => {
          if (error?.code === 'ENOENT') return undefined;
          throw error;
        });
      if (!parent) continue;
      const acquired = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      });
      if (
        !acquired?.isDirectory() ||
        acquired.isSymbolicLink() ||
        (await fs.readdir(directory)).length !== 0
      )
        continue;
      await checkTree();
      if (
        !sameWorktreeInode(acquired, await fs.lstat(directory)) ||
        !sameWorktreeInode(parent.stat, await fs.lstat(parent.parent))
      )
        throw new Error('Legacy empty directory replaced.');
      requireLaunch();
      await fs.rmdir(directory);
      await checkTree();
    }
    if (await this.#noWorktreeNeedsBlock(roomId, roots.homePath, patterns, context)) {
      await checkTree();
      await checkInstallationRoomMutationTarget(context, excludeFile);
      const parentPath = path.dirname(excludeFile),
        parent = await fs.lstat(parentPath),
        previous = await fs.lstat(excludeFile);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        !previous.isFile() ||
        previous.isSymbolicLink() ||
        (await fs.realpath(parentPath)) !==
          path.join(await fs.realpath(roots.homePath), path.relative(roots.homePath, parentPath))
      )
        throw new Error('Legacy exclude target is not its original regular file.');
      let file: Awaited<ReturnType<typeof fs.open>> | undefined;
      let failed = false,
        cause: unknown;
      try {
        requireLaunch();
        file = await fs.open(excludeFile, constants.O_RDWR | constants.O_NOFOLLOW);
        const acquired = await file.stat();
        if (!sameWorktreeInode(previous, acquired))
          throw new Error('Legacy exclude acquisition changed.');
        const current = await file.readFile('utf8'),
          next = withoutExcludeBlock(current);
        await checkTree();
        if (
          !sameWorktreeInode(acquired, await fs.lstat(excludeFile)) ||
          !sameWorktreeInode(parent, await fs.lstat(parentPath))
        )
          throw new Error('Legacy exclude publication replaced.');
        if (next !== current) {
          requireLaunch();
          requireInstallationRoomMutationTarget(context, excludeFile);
          const bytes = Buffer.from(next);
          for (let offset = 0; offset < bytes.length;) {
            await checkTree();
            if (
              !sameWorktreeInode(acquired, await fs.lstat(excludeFile)) ||
              !sameWorktreeInode(parent, await fs.lstat(parentPath))
            )
              throw new Error('Legacy exclude replaced before retained write.');
            requireLaunch();
            requireInstallationRoomMutationTarget(context, excludeFile);
            const wrote = await file.write(bytes, offset, bytes.length - offset, offset);
            if (wrote.bytesWritten <= 0)
              throw new Error('Legacy retained exclude write made no progress.');
            offset += wrote.bytesWritten;
          }
          await checkTree();
          if (
            !sameWorktreeInode(acquired, await fs.lstat(excludeFile)) ||
            !sameWorktreeInode(parent, await fs.lstat(parentPath))
          )
            throw new Error('Legacy exclude replaced after write.');
          requireLaunch();
          await file.truncate(bytes.length);
          await checkTree();
          outcome.blockRemoved = true;
        }
      } catch (error) {
        failed = true;
        cause = error;
      } finally {
        if (file)
          try {
            await file.close();
          } catch (error) {
            if (!failed) {
              failed = true;
              cause = error;
            }
          }
      }
      if (failed) throw cause;
    }
    await checkTree();
    requireLaunch();
    this.#retired.add(worktree);
    return outcome;
  }

  /**
   * Whether the room's main checkout and every worktree of this room are free
   * of untracked files the block hides — the only condition under which
   * removing it cannot make a tree read dirty. An unreadable tree answers
   * "needs it", the safe direction.
   *
   * @param roomId - The room.
   * @param ceiling - The room home directory git's search may not climb past.
   * @param patterns - The block's lines.
   */
  async #noWorktreeNeedsBlock(
    roomId: string,
    ceiling: string,
    patterns: readonly string[],
    context: InstallationRoomMutationContext
  ): Promise<boolean> {
    // `repo/` reads the same `info/exclude`, and a room's main checkout found
    // dirty stops every write to the room (`MAIN_CHECKOUT_DIRTY`) — so anything
    // the block hides there keeps it too.
    try {
      const repoDir = readInstallationRoomMutationRoots(context).repoPath;
      await checkInstallationRoomMutationTarget(context, repoDir);
      if ((await hiddenUntracked(repoDir, ceiling, patterns)).length > 0) return false;
    } catch {
      return false;
    }
    const root = path.join(readInstallationRoomMutationRoots(context).homePath, 'worktrees');
    await checkInstallationRoomMutationTarget(context, root);
    let names: string[];
    try {
      names = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (error) {
      // Unreadable siblings are not evidence that nobody needs the block.
      // Only absence under the still-current original root permits removal.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return false;
      await checkInstallationRoomMutationTarget(context, root);
      return true;
    }
    await checkInstallationRoomMutationTarget(context, root);
    for (const name of names) {
      const dir = path.join(root, name);
      await checkInstallationRoomMutationTarget(context, dir);
      if (!(await isCheckout(dir))) continue;
      try {
        if ((await hiddenUntracked(dir, ceiling, patterns)).length > 0) return false;
      } catch {
        return false;
      }
    }
    await checkInstallationRoomMutationTarget(context, root);
    return true;
  }
}

/** The folders the legacy plumbing lived under, deepest first, removed when left empty. */
const LEGACY_PARENT_DIRS = [
  ...OPERATING_SKILLS_PACK.map((skill) => path.join('.agents', 'skills', skill.name)),
  path.join('.agents', 'skills'),
  '.agents',
  path.join('.claude', 'skills'),
  '.claude',
  LEGACY_ATTACHMENTS_DIR,
  path.dirname(LEGACY_ATTACHMENTS_DIR),
  path.dirname(path.dirname(LEGACY_ATTACHMENTS_DIR)),
];

/** A file's text, or `''` when it does not exist. */
async function readIfPresent(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * The pattern lines of DorkOS's marker block in an `info/exclude` file, or none
 * when there is no block.
 *
 * @param exclude - The file's text.
 */
function blockPatterns(exclude: string): string[] {
  const start = exclude.indexOf(EXCLUDE_SENTINEL);
  if (start === -1) return [];
  const endAt = exclude.indexOf(EXCLUDE_END, start);
  const body = exclude.slice(start, endAt === -1 ? undefined : endAt);
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * The `info/exclude` file with DorkOS's block removed, and everything outside
 * it — another writer's lines — kept.
 *
 * @param current - What the file holds now.
 */
function withoutExcludeBlock(current: string): string {
  const start = current.indexOf(EXCLUDE_SENTINEL);
  if (start === -1) return current;
  const endAt = current.indexOf(EXCLUDE_END, start);
  const after = endAt === -1 ? '' : current.slice(endAt + EXCLUDE_END.length).replace(/^\n/, '');
  return `${current.slice(0, start)}${after}`;
}

/**
 * Untracked files in `worktree` that the block's `patterns` hide, as paths
 * relative to it. One `git ls-files`, file by file (a symlink to a folder is
 * one entry).
 *
 * @param worktree - The worktree.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param patterns - The block's lines.
 */
async function hiddenUntracked(
  worktree: string,
  ceiling: string,
  patterns: readonly string[]
): Promise<string[]> {
  const out = await roomHiddenUntrackedRaw(worktree, ceiling, patterns);
  // NUL records are decoded without trimming: a literal path may begin or end with a space.
  return out
    .toString('utf-8')
    .split('\0')
    .filter((rel) => rel !== '');
}

/**
 * Whether one untracked, block-hidden file is something DorkOS wrote while a
 * room turn stood in this worktree — see
 * {@link RoomWorktreeManager.retireLegacyPlumbing} for the rules.
 *
 * @param worktree - The worktree.
 * @param rel - The file, relative to it.
 * @param agentPath - The worktree's agent's home.
 */
async function isLegacyPlumbing(
  worktree: string,
  rel: string,
  agentPath: string
): Promise<boolean> {
  const posix = rel.split(path.sep).join('/');
  const abs = path.join(worktree, rel);
  if (posix.startsWith(`${LEGACY_ATTACHMENTS_DIR}/`)) return true;
  const stat = await fs.lstat(abs).catch(() => null);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    const linkIsOurs =
      posix.startsWith('.claude/skills/') ||
      (posix.startsWith('.agents/skills/') && path.basename(posix).includes('__'));
    if (!linkIsOurs) return false;
    const target = await fs.realpath(abs).catch(() => null);
    if (target === null) {
      // A dangling link into where the pack or the home was is still ours if
      // its written target says so.
      const written = path.resolve(path.dirname(abs), await fs.readlink(abs));
      return insideAny(written, [path.join(worktree, '.agents', 'skills'), agentPath]);
    }
    return insideAny(target, [
      await realOr(path.join(worktree, '.agents', 'skills')),
      await realOr(agentPath),
    ]);
  }
  if (!stat.isFile()) return false;
  const seeded = OPERATING_SKILLS_PACK.find(
    (skill) => posix === `.agents/skills/${skill.name}/SKILL.md`
  );
  if (seeded) return isUnmodifiedSeededSkill(abs, await fs.readFile(abs, 'utf-8'));
  if (posix === '.agents/harness.manifest.json') {
    try {
      const parsed = JSON.parse(await fs.readFile(abs, 'utf-8')) as { harnesses?: unknown };
      return (
        Array.isArray(parsed.harnesses) &&
        parsed.harnesses.length === AGENT_WORKSPACE_HARNESSES.length &&
        AGENT_WORKSPACE_HARNESSES.every((h, i) => (parsed.harnesses as unknown[])[i] === h)
      );
    } catch {
      return false;
    }
  }
  if (posix === '.claude/CLAUDE.md') {
    return (await fs.readFile(abs, 'utf-8')) === CLAUDE_INSTRUCTION_CONTENT;
  }
  return false;
}

/** Whether `target` is one of `roots` or inside one. */
function insideAny(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/** A folder's real path, or its resolved spelling when it does not exist. */
async function realOr(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Remove each of `rels` under `root` that is an empty directory, in order —
 * so a list given deepest first clears a chain of emptied parents.
 *
 * @param root - The worktree.
 * @param rels - Folders relative to it.
 */
async function pruneEmptyDirs(root: string, rels: readonly string[]): Promise<void> {
  for (const rel of rels) {
    const dir = path.join(root, rel);
    try {
      const stat = await fs.lstat(dir);
      if (stat.isDirectory() && (await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
    } catch {
      // Gone, or not ours to remove.
    }
  }
}

/**
 * Remove every empty directory at or under `dir`, deepest first — the entry
 * folders the attachment projector made, once their files are gone. A folder
 * that still holds anything is kept.
 *
 * @param dir - The folder to tidy.
 */
async function pruneEmptyTree(dir: string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyTree(path.join(dir, entry.name));
  }
  try {
    if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
  } catch {
    // Not empty, or already gone.
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

function sameWorktreeInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
