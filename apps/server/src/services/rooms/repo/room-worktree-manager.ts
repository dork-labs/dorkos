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
import type {
  RoomWorktreeHandle,
  RoomWorktreeStatus,
  RoomWorktreeSweepResult,
  RoomWorktreeManagerDeps,
} from './worktree/room-worktree-contracts.js';
export type {
  RoomWorktreeHandle,
  RoomWorktreeStatus,
  RoomWorktreeSweepResult,
  RoomWorktreeManagerDeps,
} from './worktree/room-worktree-contracts.js';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { RoomContextFiles } from '@dorkos/shared/additional-context';
import { slugifyAgentName } from '@dorkos/shared/validation';
import { OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';
import { logger } from '../../../lib/logger.js';

import { PROJECTED_ATTACHMENTS_ROOT } from '../attachments/attachment-paths.js';
import type { RoomRepoStore } from './room-repo-store.js';
import type { RoomWorktreeRefreshTarget } from './worktree/room-worktree-refresh.js';
import { aheadBehind, commitsAheadOfMain, hasUncommittedChanges } from './room-repo-git.js';

import type { Db } from '@dorkos/db';
import type { RoomStore } from '../room-store.js';
import { requireRoomServiceFileWriteOwner, type RoomService } from '../room-service.js';

import type { RoomTurnRequest } from '../room-turn-port.js';
import { type RoomTurnLaunch, type RoomTurnPlace } from './room-turn-place.js';

import type { DocChannelStore } from '../../canvas/doc-channel/store.js';
import {
  requireInstallationFileWritesOwner,
  type InstallationFileWrites,
} from '../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  requireInstallationRoomWrites,
  readInstallationRoomFileWriteOwner,
  requireInstallationRoomLaunchTarget,
  type InstallationRoomWrites,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';

import { readOriginalRoomRepoMaintenanceOperation } from './room-repo-reconciler.js';

import { DocChannelNotFoundError } from '../../canvas/doc-channel/authorization.js';
import {
  requireOriginalHttpRoomWorktreeOwner,
  requireOriginalHttpRoomWorktreeAdmission,
} from '../../canvas/doc-channel/http-composition.js';

/** Exact original installation identities required for constructor-owned Worktree effects. */
export interface RoomWorktreeOwningConstruction {
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

import { retireOwned as retireOriginalWorktreeLegacy } from './worktree/room-worktree-retirement.js';
import type { RoomWorktreeRetirementView } from './worktree/room-worktree-retirement-contracts.js';
const originalWorktreeRetirementFreeze = Object.freeze;
const originalWorktreeRetirementApply = Reflect.apply;
const originalWorktreeRetirementGet = WeakMap.prototype.get;
const originalWorktreeRetirementSet = WeakMap.prototype.set;
const originalWorktreeRetirementViews = new WeakMap<object, RoomWorktreeRetirementView>();
/** Read only a genuine constructor-private legacy retirement view before any native effect. */
export function readOriginalRoomWorktreeRetirementView(owner: object): RoomWorktreeRetirementView {
  const view = originalWorktreeRetirementApply(
    originalWorktreeRetirementGet,
    originalWorktreeRetirementViews,
    [owner]
  ) as RoomWorktreeRetirementView | undefined;
  if (!view) throw new DocChannelNotFoundError();
  return view;
}

import {
  executePlacement as originalWorktreeExecutePlacement,
  executeLaunch as originalWorktreeExecuteLaunch,
} from './worktree/room-worktree-placement.js';
import type { RoomWorktreeConstructionView } from './worktree/room-worktree-construction-contracts.js';
const originalWorktreeConstructionViews = new WeakMap<object, RoomWorktreeConstructionView>();
/** Resolve only the actual constructor-private Worktree construction view before any native effect. */
export function readOriginalRoomWorktreeConstructionView(
  owner: object
): RoomWorktreeConstructionView {
  const view = originalWorktreeRetirementApply(
    originalWorktreeRetirementGet,
    originalWorktreeConstructionViews,
    [owner]
  ) as RoomWorktreeConstructionView | undefined;
  if (!view) throw new DocChannelNotFoundError();
  return view;
}

import {
  reapOwned as originalWorktreeReapOwned,
  lastTouchedAt as originalWorktreeLastTouchedAt,
} from './worktree/room-worktree-reap.js';
import type { RoomWorktreeReapView } from './worktree/room-worktree-reap-contracts.js';
const originalWorktreeReapViews = new WeakMap<object, RoomWorktreeReapView>();
/** Resolve only an actual constructor-private Worktree reap view before observing or mutating native state. */
export function readOriginalRoomWorktreeReapView(owner: object): RoomWorktreeReapView {
  const view = originalWorktreeRetirementApply(
    originalWorktreeRetirementGet,
    originalWorktreeReapViews,
    [owner]
  ) as RoomWorktreeReapView | undefined;
  if (!view) throw new DocChannelNotFoundError();
  return view;
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
  readonly #reapKey = originalWorktreeRetirementFreeze({});
  readonly #constructionKey = originalWorktreeRetirementFreeze({});
  readonly #retirementKey = originalWorktreeRetirementFreeze({});
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
    /** Capture only the original private reap maps and native owner at the construction frontier. */
    function createReapView(owner: RoomWorktreeManager): RoomWorktreeReapView {
      return originalWorktreeRetirementFreeze({
        originalManager: owner,
        get owning() {
          return owner.#owning;
        },
        originalManagers: originalWorktreeManagers,
        reapContexts: originalReapContexts,
        reapEffects: originalReapEffects,
        slugDigestChars: SLUG_DIGEST_CHARS,
        nowMs: () => owner.#nowMs(),
      });
    }
    originalWorktreeRetirementApply(originalWorktreeRetirementSet, originalWorktreeReapViews, [
      this.#reapKey,
      createReapView(this),
    ]);
    /** Capture fixed construction dependencies and original private receiver helpers. */
    function createConstructionView(owner: RoomWorktreeManager): RoomWorktreeConstructionView {
      return originalWorktreeRetirementFreeze({
        originalManager: owner,
        get deps() {
          return owner.#deps;
        },
        get owning() {
          return owner.#owning;
        },
        get retired() {
          return owner.#retired;
        },
        nowMs: () => owner.#nowMs(),
        sameWorktreeInode,
        directoryExists,
        isCheckout,
      });
    }
    originalWorktreeRetirementApply(
      originalWorktreeRetirementSet,
      originalWorktreeConstructionViews,
      [this.#constructionKey, createConstructionView(this)]
    );
    /** Capture the exact original manager and live private retirement set. */
    function createRetirementView(owner: RoomWorktreeManager): RoomWorktreeRetirementView {
      return originalWorktreeRetirementFreeze({
        originalManager: owner,
        get retired() {
          return owner.#retired;
        },
        LEGACY_PARENT_DIRS,
        LEGACY_ATTACHMENTS_DIR,
        EXCLUDE_SENTINEL,
        EXCLUDE_END,
      });
    }
    originalWorktreeRetirementApply(
      originalWorktreeRetirementSet,
      originalWorktreeRetirementViews,
      [this.#retirementKey, createRetirementView(this)]
    );
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

  #executePlacement(token: object): Promise<RoomTurnPlace> {
    return originalWorktreeExecutePlacement(this.#constructionKey, token);
  }

  #executeLaunch(request: RoomTurnRequest): Promise<RoomTurnLaunch> {
    return originalWorktreeExecuteLaunch(this.#constructionKey, request);
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

  #reapOwned(
    roomId: string,
    context: InstallationRoomMutationContext
  ): Promise<RoomWorktreeSweepResult> {
    return originalWorktreeReapOwned(this.#reapKey, roomId, context);
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
  #lastTouchedAt(dir: string, ceiling: string): Promise<Date> {
    return originalWorktreeLastTouchedAt(this.#reapKey, dir, ceiling);
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

  #retireOwned(
    roomId: string,
    worktree: string,
    agentPath: string,
    context: InstallationRoomMutationContext
  ): Promise<{ removed: number; blockRemoved: boolean }> {
    return retireOriginalWorktreeLegacy(this.#retirementKey, roomId, worktree, agentPath, context);
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

function sameWorktreeInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
