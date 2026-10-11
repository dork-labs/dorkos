/**
 * Giving a room files, and taking them away again (spec `project-rooms` §3.2).
 *
 * Four things live here, and they are the four that need a policy rather than
 * a filesystem call:
 *
 * - **Enabling.** Operator-only, feature-flagged, idempotent. Writes the
 *   sidecar, creates the repo, seeds `ROOM.md`, commits it as the person who
 *   asked.
 * - **Archiving.** Nothing. It is documented and pinned by a test because
 *   "nothing happens" is the decision, not an omission: an archived room's
 *   files are exactly where its members left them, and un-archiving returns
 *   them.
 * - **Hard delete.** Refused while any agent's worktree holds work that is not
 *   in `main`, unless the operator forces it. Nothing in the product deletes a
 *   room today, so this is the guard the path that eventually does must call —
 *   `room_repos.room_id` cascades the ROW away and SQLite cannot touch the
 *   directory, so the on-disk half has to be somebody's job, and it is this
 *   one's.
 * - **What a room's files say to a turn.** The composing itself is
 *   `room-conventions.ts`'s; what belongs here is holding the one instance, so
 *   the cache it keeps has the same lifetime as the service that knows when a
 *   room's files go away.
 *
 * @module server/services/rooms/repo/room-repo-service
 */

import type {
  RoomMainRepair,
  RepairAction,
  RoomMainRepairResult,
  EnableRoomRepoResult,
  RoomRepoServiceDeps,
  RoomRepoOwningConstruction,
} from './repository-service/room-repo-service-contracts.js';
export type {
  RoomMainRepair,
  RepairAction,
  RoomMainRepairResult,
  EnableRoomRepoResult,
  RoomRepoServiceDeps,
  RoomRepoOwningConstruction,
} from './repository-service/room-repo-service-contracts.js';
import { promises as fs, type Stats } from 'node:fs';

import path from 'node:path';
import type { Room } from '@dorkos/shared/room-schemas';
import { type RoomRepoSidecar } from '@dorkos/shared/room-repo';
import { RoomError } from '../data/room-errors.js';
import { logger } from '../../../lib/logger.js';
import { type RoomRepoStore } from './room-repo-store.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';
import { commitsAheadOfMain, hasUncommittedChanges, type StrayChange } from './room-repo-git.js';

import { RoomConventions } from './room-conventions.js';

/**
 * The code a caller sees when the room already has files.
 *
 * Not a {@link RoomError} code, and that is the one asymmetry in this module:
 * the answer carries the EXISTING binding so the caller can act on it, and a
 * `RoomError` is a message and a code with nowhere to put a payload. Enabling a
 * repo twice is an outcome, not a malformed request.
 */
export const ROOM_REPO_EXISTS_CODE = 'ROOM_REPO_EXISTS';

/**
 * The commit subject a stray-change rescue carries.
 *
 * One string, in one place, because it is the sentence a person will find in
 * `git log` months later trying to work out what happened — and it is the only
 * commit in a room's history nobody chose the wording of.
 */
const STRAY_CHANGES_COMMIT_MESSAGE = 'Keep changes made outside DorkOS';

/** What a repair did, before the room's files are looked at again. */

import type { Db } from '@dorkos/db';

import { requireRoomServiceFileWriteOwner, type RoomService } from '../room-service.js';
import {
  requireInstallationFileWritesOwner,
  type InstallationFileWrites,
} from '../../canvas/doc-channel/writes/installation-file-writes.js';

import {
  requireInstallationRoomWrites,
  readInstallationRoomFileWriteOwner,
  readInstallationRoomMutationRoots,
  requireInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  captureDocHttpRoomRepoCaller,
  readDocHttpRoomRepoCaller,
} from '../../canvas/doc-channel/http-composition.js';
import { DocChannelNotFoundError } from '../../canvas/doc-channel/authorization.js';
import {
  executeEnable as originalRepoExecuteEnable,
  executeRepair as originalRepoExecuteRepair,
} from './repository-service/room-repo-service-operations.js';

const originalRepoStoreOperations = new WeakMap<
  InstallationRoomMutationContext,
  {
    service: RoomRepoService;
    handle: object;
    owning: RoomRepoOwningConstruction;
    store: RoomRepoStore;
    mutex: RoomRepoMutex;
    roomId: string;
    operation: 'enable' | 'repair';
  }
>();
/** Fixed original active operation lookup. A namespace/context DTO cannot register a Store mutation. */
export function readOriginalRoomRepoStoreOperation(
  context: InstallationRoomMutationContext,
  store: RoomRepoStore,
  db: Db
): Readonly<{ roomId: string }> | undefined {
  const operation = originalRepoStoreOperations.get(context);
  if (!operation || operation.owning.db !== db || operation.store !== store) return undefined;
  requireRoomRepoServiceOwner(
    operation.service,
    operation.owning.owner,
    db,
    operation.owning.rooms
  );
  if (
    readInstallationRoomFileWriteOwner(operation.owning.writer, store, operation.mutex) !==
    operation.owning.owner
  )
    return undefined;
  const caller = readDocHttpRoomRepoCaller(
    operation.owning.owner,
    operation.service,
    operation.handle,
    operation.operation
  );
  if (caller.roomId !== operation.roomId || originalRepoStoreOperations.get(context) !== operation)
    return undefined;
  requireInstallationRoomMutationTarget(
    context,
    readInstallationRoomMutationRoots(context).homePath
  );
  return Object.freeze({ roomId: operation.roomId });
}
/** Cleanup proof is the original still-awaited service operation, never renewed forward permission. */
export function readOriginalRoomRepoCleanupOperation(
  context: InstallationRoomMutationContext,
  store: RoomRepoStore,
  db: Db
): Readonly<{ roomId: string }> | undefined {
  const operation = originalRepoStoreOperations.get(context);
  if (!operation || operation.owning.db !== db || operation.store !== store) return undefined;
  requireRoomRepoServiceOwner(
    operation.service,
    operation.owning.owner,
    db,
    operation.owning.rooms
  );
  if (
    readInstallationRoomFileWriteOwner(operation.owning.writer, store, operation.mutex) !==
      operation.owning.owner ||
    originalRepoStoreOperations.get(context) !== operation
  )
    return undefined;
  // This map is installed only inside the original namespace callback and retired in its finally.
  // It intentionally does not renew caller rights: only private acquired receipts consume this proof.
  return Object.freeze({ roomId: operation.roomId });
}
const originalRepoServices = new WeakMap<
  RoomRepoService,
  {
    owning: RoomRepoOwningConstruction;
    preflight(): void;
    enable(handle: object): Promise<EnableRoomRepoResult>;
    repair(handle: object, input: RoomMainRepair): Promise<RoomMainRepairResult>;
  }
>();
/** Require the Room repository service's exact original owner dependencies. */
export function requireRoomRepoServiceOwner(
  service: RoomRepoService,
  owner: InstallationFileWrites,
  db: Db,
  rooms: RoomService
): undefined {
  const binding = originalRepoServices.get(service);
  if (
    !binding ||
    binding.owning.owner !== owner ||
    binding.owning.db !== db ||
    binding.owning.rooms !== rooms
  )
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, db, binding.owning.channels);
  requireRoomServiceFileWriteOwner(rooms, db, binding.owning.roomStore);
  if (!db.$client.open || db.$client.inTransaction) throw new DocChannelNotFoundError();
  return undefined;
}
/** Enable the repository through the original Room repository caller. */
export function executeRoomRepoEnable(
  service: RoomRepoService,
  handle: object
): Promise<EnableRoomRepoResult> {
  const binding = originalRepoServices.get(service);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  requireRoomRepoServiceOwner(
    service,
    binding.owning.owner,
    binding.owning.db,
    binding.owning.rooms
  );
  return binding.enable(handle);
}
/** Repair the repository through the original Room repository caller. */
export function executeRoomRepoRepair(
  service: RoomRepoService,
  handle: object,
  input: RoomMainRepair
): Promise<RoomMainRepairResult> {
  const binding = originalRepoServices.get(service);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  requireRoomRepoServiceOwner(
    service,
    binding.owning.owner,
    binding.owning.db,
    binding.owning.rooms
  );
  return binding.repair(handle, input);
}

/** Route captures only through the actual constructor-owned service and verified HTTP composition. */
export function captureRoomRepoHttpOperation(
  service: RoomRepoService,
  req: import('express').Request,
  res: import('express').Response,
  roomId: string,
  operation: 'enable' | 'repair'
): Promise<object> {
  const binding = originalRepoServices.get(service);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  requireRoomRepoServiceOwner(
    service,
    binding.owning.owner,
    binding.owning.db,
    binding.owning.rooms
  );
  binding.preflight();
  return captureDocHttpRoomRepoCaller(binding.owning.owner, service, req, res, roomId, operation);
}

import type { RoomRepoServiceView } from './repository-service/room-repo-service-method-contracts.js';
const repoServiceFreeze = Object.freeze;
const repoServiceGet = WeakMap.prototype.get;
const repoServiceSet = WeakMap.prototype.set;
const repoServiceApply = Reflect.apply;
const originalRepoMethodViews = new WeakMap<object, RoomRepoServiceView>();
/** Resolve only the actual root-private repo service operation view before any native effects. */
export function readOriginalRoomRepoServiceView(owner: object): RoomRepoServiceView {
  const view = repoServiceApply(repoServiceGet, originalRepoMethodViews, [owner]) as
    RoomRepoServiceView | undefined;
  if (!view) throw new DocChannelNotFoundError();
  return view;
}
import {
  enableUnderLock as originalRepoEnableUnderLock,
  seedGuarded as originalRepoSeedGuarded,
  repoIsInitialised as originalRepoRepoIsInitialised,
} from './repository-service/room-repo-service-enable.js';
import {
  repairUnderLock as originalRepoRepairUnderLock,
  keepStrayChanges as originalRepoKeepStrayChanges,
  discardStrayChanges as originalRepoDiscardStrayChanges,
} from './repository-service/room-repo-service-repair.js';
import {
  seedRepo as originalRepoSeedRepo,
  unwindFailedEnable as originalRepoUnwindFailedEnable,
} from './repository-service/room-repo-service-seed.js';

/** Enabling, archiving and deleting a room's files. */
export class RoomRepoService {
  readonly #operationKey = repoServiceFreeze({});
  /**
   * The `ROOM.md` composer, built here because it needs exactly what this
   * service already holds: the store's paths, the feature flag, and the live
   * delivery cap. Callers reach it through
   * {@link RoomRepoService.conventionsFor}.
   */
  readonly #conventions: RoomConventions;
  readonly #deps: Readonly<RoomRepoServiceDeps>;
  readonly #owning?: RoomRepoOwningConstruction;
  readonly #acquiredSeedRepos = new WeakMap<
    InstallationRoomMutationContext,
    { roomId: string; home: string; homeStat: Stats; repo: string; repoStat: Stats }
  >();

  constructor(deps: RoomRepoServiceDeps, owning?: RoomRepoOwningConstruction) {
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
        readInstallationRoomFileWriteOwner(owning.writer, deps.store, deps.mutex) !== owning.owner
      )
        throw new DocChannelNotFoundError();
      requireRoomServiceFileWriteOwner(owning.rooms, owning.db, owning.roomStore);
      this.#owning = Object.freeze({ ...owning });
      originalRepoServices.set(
        this,
        Object.freeze({
          owning: this.#owning,
          preflight: () => this.#requireEnabled(),
          enable: (handle: object) => this.#executeEnable(handle),
          repair: (handle: object, input: RoomMainRepair) => this.#executeRepair(handle, input),
        })
      );
    }
    this.#conventions = new RoomConventions({
      hasRepo: (roomId) => this.hasRepo(roomId),
      repoPath: (roomId) => deps.store.repoPath(roomId),
      homeDir: (roomId) => deps.store.homeDir(roomId),
      maxRoomMdBytes: deps.maxRoomMdBytes,
    });

    /** Capture the original private methods and state without exposing a writable registration seam. */
    function createMethodView(owner: RoomRepoService): RoomRepoServiceView {
      return repoServiceFreeze({
        originalService: owner,
        get deps() {
          return owner.#deps;
        },
        get owning() {
          return owner.#owning;
        },
        get acquiredSeedRepos() {
          return owner.#acquiredSeedRepos;
        },
        requireEnabled: () => owner.#requireEnabled(),
        operations: originalRepoStoreOperations,
        sameRepoInode,
        strayChangesCommitMessage: STRAY_CHANGES_COMMIT_MESSAGE,
        enableUnderLock: (...args: Parameters<RoomRepoServiceView['enableUnderLock']>) =>
          owner.#enableUnderLock(...args),
        seedGuarded: (...args: Parameters<RoomRepoServiceView['seedGuarded']>) =>
          owner.#seedGuarded(...args),
        repoIsInitialised: (...args: Parameters<RoomRepoServiceView['repoIsInitialised']>) =>
          owner.#repoIsInitialised(...args),
        repairUnderLock: (...args: Parameters<RoomRepoServiceView['repairUnderLock']>) =>
          owner.#repairUnderLock(...args),
        keepStrayChanges: (...args: Parameters<RoomRepoServiceView['keepStrayChanges']>) =>
          owner.#keepStrayChanges(...args),
        discardStrayChanges: (...args: Parameters<RoomRepoServiceView['discardStrayChanges']>) =>
          owner.#discardStrayChanges(...args),
        seedRepo: (...args: Parameters<RoomRepoServiceView['seedRepo']>) =>
          owner.#seedRepo(...args),
        unwindFailedEnable: (...args: Parameters<RoomRepoServiceView['unwindFailedEnable']>) =>
          owner.#unwindFailedEnable(...args),
      });
    }
    repoServiceApply(repoServiceSet, originalRepoMethodViews, [
      this.#operationKey,
      createMethodView(this),
    ]);
  }

  /**
   * The conventions block this room's `ROOM.md` should ride into a turn on, or
   * `null` when this room has nothing to say (spec §3.3).
   *
   * Resolved at TURN START and held by the caller for the whole turn: it reads
   * the commit `main` points at, so a merge landing mid-turn takes effect at the
   * next turn boundary rather than under a running agent.
   *
   * @param room - The room being answered.
   * @param room.id - The room id.
   * @param room.title - The room's title, as its members set it.
   * @returns The block, or `null`.
   */
  conventionsFor(room: { id: string; title: string }): Promise<string | null> {
    return this.#conventions.compose(room);
  }

  /**
   * Give a room files, or answer with the ones it already has.
   *
   * The refusals, in the order they are asked:
   *
   * 1. **The feature is off** — `ROOM_REPOS_DISABLED`. An install-level fact,
   *    checked first because it is true regardless of who is asking and of
   *    whether the room exists.
   * 2. **The caller cannot see the room** — `ROOM_NOT_FOUND`, the same answer
   *    reading it would give. Before the operator gate on purpose (DOR-1429's
   *    order), so an agent probing room ids cannot tell 403 from 404.
   * 3. **The caller is not the operator** — `OPERATOR_ONLY`. Never an agent
   *    capability: a room that could give itself a repo is a room that could
   *    grant itself a working directory, which is the confused-deputy shape the
   *    membership verbs already refuse.
   *
   * **Order of writes, and what an interruption leaves behind.** The sidecar is
   * written first (it is the truth; see `room-repo-store.ts`), then the git
   * repo is created and seeded. Two things follow, and between them the
   * half-state has no way to become permanent:
   *
   * - A **failure** in the git half unwinds both, binding first
   *   ({@link RoomRepoService.unwindFailedEnable}), because a binding whose
   *   repo does not exist would be advertised to every member and satisfy
   *   nothing.
   * - A **crash** between them cannot run that unwind, so it leaves a sidecar
   *   with no repo — and the reconciler cannot heal it, since a sidecar is all
   *   the reconciler looks at. This method heals it instead: a binding whose
   *   `repo/` is not a git repository falls through and seeds, rather than
   *   answering `created: false` about files that are not there. Without that,
   *   the only way out was deleting the sidecar by hand.
   *
   * **Serialized on the room's own queue, and that is a fix rather than
   * tidiness.** Everything below is a check-then-act with an `await` in the
   * middle: read the sidecar, decide there is no repo, create one. Two calls for
   * one room both read "no repo", both ran `git init -b main` in the same
   * directory, and the second re-initialised the repository the first had just
   * seeded — destroying its `ROOM.md` commit while answering `201`. Holding the
   * merge queue's lane for the whole method makes the second caller read the
   * sidecar the first one wrote, and answer `created: false` with the binding
   * that exists. It is the SAME lane merges take, so a merge can never run
   * against a repo halfway through being created either.
   *
   * @param roomId - The room to give files to.
   * @param callerAuthorId - Who is asking.
   * @returns The binding, and whether this call is what made it.
   * @throws {RoomError} `ROOM_REPOS_DISABLED`, `ROOM_NOT_FOUND`,
   *   `OPERATOR_ONLY`, or `ROOM_REPO_GIT_UNAVAILABLE` when this machine has no
   *   git.
   */
  enable(_roomId: string, _callerAuthorId: string): Promise<EnableRoomRepoResult> {
    return Promise.reject(new DocChannelNotFoundError());
  }

  #requireEnabled(): void {
    if (!this.#deps.enabled())
      throw new RoomError(
        'ROOM_REPOS_DISABLED',
        'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
      );
  }
  #executeEnable(handle: object): Promise<EnableRoomRepoResult> {
    return originalRepoExecuteEnable(this.#operationKey, handle);
  }

  /**
   * The body of {@link RoomRepoService.enable}, run while holding the room's
   * queue.
   *
   * @param roomId - The room to give files to.
   * @param callerAuthorId - Who is asking.
   * @returns The binding, and whether this call is what made it.
   */
  #enableUnderLock(
    roomId: string,
    callerAuthorId: string,
    context: InstallationRoomMutationContext
  ): Promise<EnableRoomRepoResult> {
    return originalRepoEnableUnderLock(this.#operationKey, roomId, callerAuthorId, context);
  }

  /**
   * Seed the repo, and unwind the binding if that fails.
   *
   * Split out because both {@link RoomRepoService.enable} branches need it —
   * the fresh one and the one healing a binding whose repo never got made — and
   * a second copy of "unwind on failure" is a second chance to forget it.
   *
   * @param roomId - The room.
   * @param room - Its title and topic, for the seeded file.
   * @param callerAuthorId - Who asked.
   * @throws {RoomError} `ROOM_REPO_GIT_UNAVAILABLE` when this machine has no
   *   git, and otherwise whatever git failed with.
   */
  #seedGuarded(
    roomId: string,
    room: Room,
    callerAuthorId: string,
    context: InstallationRoomMutationContext,
    publish?: RoomRepoSidecar
  ): Promise<void> {
    return originalRepoSeedGuarded(
      this.#operationKey,
      roomId,
      room,
      callerAuthorId,
      context,
      publish
    );
  }

  /**
   * Whether the repo behind a binding actually exists.
   *
   * Asks for `.git` rather than running a git command: this runs on the enable
   * path, the answer is a yes/no about a directory, and spawning a process to
   * learn it would put a process spawn in front of every repeat call.
   *
   * @param roomId - The room.
   */
  #repoIsInitialised(roomId: string, context?: InstallationRoomMutationContext): Promise<boolean> {
    return originalRepoRepoIsInitialised(this.#operationKey, roomId, context);
  }

  /**
   * Deal with changes in a room's own copy that DorkOS did not make — the
   * recovery half of the spec's dirty-main degradation (§3.10).
   *
   * While `repo/` holds anything uncommitted, every merge and every save in the
   * room refuses `MAIN_CHECKOUT_DIRTY` (`room-main-checkout.ts`). That refusal
   * is deliberate and it is also a dead end unless somebody can END it, which is
   * what this is: **keep those changes as a commit, or throw away exactly the
   * ones you name.**
   *
   * Two asymmetries, both on purpose:
   *
   * - **Committing takes no list and discarding demands one.** Committing
   *   loses nothing, so sweeping up whatever is there is safe. Discarding is
   *   the only irreversible act in the whole room-repo surface, so it destroys
   *   nothing it was not handed by name — and every name has to be one the room
   *   is reporting right now, so a stale screen cannot delete something that
   *   arrived after it was drawn.
   * - **Operator-only.** It is the operator's own terminal that put those
   *   changes there, and deciding what happens to somebody's unsaved work is
   *   not a decision to hand an agent, or even another member.
   *
   * **A checkout on the wrong branch is refused rather than fixed.** DorkOS
   * never moves it there, and moving it back would run a checkout over work
   * somebody left in the tree — the corruption the whole refusal exists to
   * prevent. The message says what to do.
   *
   * **Authorization is answered before the queue, and git state inside it** —
   * the ordering `RoomMergeService.merge` and `RoomFileEditor.save` both write
   * down, and this used to be the one write that did the opposite. Who may
   * repair a room does not change while a caller waits, so asking first refuses
   * a caller who was never allowed immediately rather than after somebody
   * else's merge; everything git can say has to be asked inside the lane,
   * because a merge running ahead of this one can change all of it.
   *
   * @param roomId - The room whose files are stuck.
   * @param callerAuthorId - Who is asking. Must be the operator.
   * @param repair - Keep everything, or discard exactly these paths.
   * @returns What it did, and whether the room's files are clean now.
   * @throws {RoomError} `ROOM_REPOS_DISABLED`, `ROOM_NOT_FOUND`,
   *   `OPERATOR_ONLY`, `ROOM_HAS_NO_REPO`, `MAIN_CHECKOUT_DIRTY` for a checkout
   *   on the wrong branch, `ROOM_FILE_NOT_FOUND` for a path the room is not
   *   reporting, or `ROOM_REPO_GIT_UNAVAILABLE`.
   */
  async repairMainCheckout(
    _roomId: string,
    _callerAuthorId: string,
    _repair: RoomMainRepair
  ): Promise<RoomMainRepairResult> {
    throw new DocChannelNotFoundError();
  }

  #executeRepair(handle: object, repair: RoomMainRepair): Promise<RoomMainRepairResult> {
    return originalRepoExecuteRepair(this.#operationKey, handle, repair);
  }

  /**
   * The git half of {@link RoomRepoService.repairMainCheckout}, run while
   * holding the room's queue.
   *
   * Everything it does can be changed by a merge or a save running ahead of it,
   * which is exactly why it is in here and the authorization is not.
   *
   * @param roomId - The room.
   * @param repair - What the operator asked for.
   * @returns What it did.
   */
  #repairUnderLock(
    roomId: string,
    repair: RoomMainRepair,
    context: InstallationRoomMutationContext
  ): Promise<RoomMainRepairResult> {
    return originalRepoRepairUnderLock(this.#operationKey, roomId, repair, context);
  }

  /**
   * Commit whatever is in the room's own copy, as the operator.
   *
   * `commitAll` rather than a named list: this is the "keep it" answer, and
   * keeping half of what is there would leave the room stuck for the other
   * half.
   *
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   * @param strayCount - How many paths were waiting, for the answer.
   * @returns What was committed.
   */
  #keepStrayChanges(
    repoDir: string,
    ceiling: string,
    strayCount: number,
    context: InstallationRoomMutationContext
  ): Promise<RepairAction> {
    return originalRepoKeepStrayChanges(this.#operationKey, repoDir, ceiling, strayCount, context);
  }

  /**
   * Throw away exactly the named changes, and nothing else.
   *
   * Every path has to be one the room is reporting as changed RIGHT NOW,
   * compared byte for byte against git's own output — no normalising, no case
   * folding, no prefix matching. That single rule is what makes this narrow: a
   * path the caller invented, a path that has since been committed, and a path
   * from a screen drawn ten minutes ago are all refused rather than acted on.
   *
   * Then two ways to undo, chosen per path by whether `HEAD` has it: restore it
   * from the commit, or take it out of the index and delete the file. `git
   * clean` is deliberately not used — its whole reputation is for removing more
   * than it was asked to.
   *
   * **A rename is one change with two paths, and undoing it needs both.**
   * `git mv notes.md renamed.md` is reported as one stray — `renamed.md`, which
   * `HEAD` does not hold — so the removal half alone deleted `renamed.md` and
   * left `notes.md` still missing: the file was gone from the room, and the room
   * was still stuck. So a discarded rename also restores the name it came from
   * ({@link StrayChange.renamedFrom}), which is the only reading of "undo" that
   * ends with the room where it started.
   *
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   * @param strays - What the room is reporting as changed.
   * @param paths - What the operator named.
   * @returns How many paths were discarded — the paths the operator named, not
   *   the files that were touched putting them back.
   * @throws {RoomError} `ROOM_FILE_NOT_FOUND` naming the first path that is not
   *   one of the reported changes.
   */
  #discardStrayChanges(
    repoDir: string,
    ceiling: string,
    strays: readonly StrayChange[],
    paths: readonly string[],
    context: InstallationRoomMutationContext
  ): Promise<RepairAction> {
    return originalRepoDiscardStrayChanges(
      this.#operationKey,
      repoDir,
      ceiling,
      strays,
      paths,
      context
    );
  }

  /**
   * Whether this room has files a caller may use right now.
   *
   * Off by the feature flag as well as by the absence of a binding, which is
   * what makes `config.rooms.repo.enabled: false` behave as "every room is a
   * room without files" rather than as "no NEW room may have files": a room
   * that already has a repo stops offering it, and nothing on disk is touched.
   *
   * @param roomId - The room.
   */
  hasRepo(roomId: string): boolean {
    return this.#deps.enabled() && this.#deps.store.getRow(roomId) !== null;
  }

  /**
   * Where this room's own shared copy of its files lives, or `null` when it has
   * none a caller may use.
   *
   * The one question the canvas asks of this service, and it asks it on a read
   * path: a canvas document that resolved under the SHARED tree is one every
   * member can already read, which is what makes returning its contents to any
   * of them safe (spec `room-canvas` §8.1). A room with no repo answers `null`,
   * and then no document belongs to a shared tree at all.
   *
   * @param roomId - The room.
   * @returns The absolute path, or `null`.
   */
  repoPathFor(roomId: string): string | null {
    return this.hasRepo(roomId) ? this.#deps.store.repoPath(roomId) : null;
  }

  /**
   * Where this room keeps its members' own working copies.
   *
   * The sibling of {@link RoomRepoService.repoPathFor}, and asked by the same
   * kind of caller: the review surface has to confine a worktree document's
   * stored directory to somewhere DorkOS itself made (spec `canvas-agent-seat`
   * §8), and a path a row happens to hold is not a checked input. A room with
   * no repo answers `null`, and then no directory is inside anything.
   *
   * @param roomId - The room.
   * @returns The absolute path, or `null`.
   */
  worktreesPathFor(roomId: string): string | null {
    return this.hasRepo(roomId) ? this.#deps.store.worktreesPath(roomId) : null;
  }

  /**
   * Which of a room's agent worktrees hold work that `main` does not have.
   *
   * "Stranded" is either half of the same worry: uncommitted edits, or commits
   * that were never merged back. A worktree with neither is safe to remove; one
   * with either is somebody's unfinished work.
   *
   * @param roomId - The room.
   * @returns The worktree directory names, sorted, or an empty list.
   */
  async listStrandedWorktrees(roomId: string): Promise<string[]> {
    const root = this.#deps.store.worktreesPath(roomId);
    // Git's repository search may not climb past the room's own home. Without
    // it, a directory under `worktrees/` that is NOT a checkout answers for
    // whatever repository encloses the DorkOS data directory — in dev, the
    // dorkos checkout — and this guard would call somebody's stranded work
    // clean. See `room-repo-git.ts`.
    const ceiling = this.#deps.store.homeDir(roomId);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }

    const stranded: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      // A directory git cannot read is stranded by default. It is not this
      // guard's job to decide that something it does not understand is
      // disposable.
      try {
        if (
          (await hasUncommittedChanges(dir, ceiling)) ||
          (await commitsAheadOfMain(dir, ceiling)) > 0
        ) {
          stranded.push(entry.name);
        }
      } catch (err) {
        logger.warn('[rooms] could not read a room worktree; treating it as unfinished work', {
          roomId,
          worktree: entry.name,
          err,
        });
        stranded.push(entry.name);
      }
    }
    return stranded.sort();
  }

  /**
   * Refuse to delete a room's files while an agent still has work in them.
   *
   * The guard the future hard-delete path must call BEFORE it removes the room
   * row — once the row is gone the cascade has already taken `room_repos` with
   * it, and the directory is left with nobody to ask.
   *
   * Archiving must not call this at all: an archived room keeps everything.
   *
   * @param roomId - The room about to be deleted.
   * @param options - `force: true` when the operator has been shown the
   *   stranded work and asked for it to go anyway.
   * @throws {RoomError} `ROOM_REPO_UNMERGED_WORK` naming every worktree that
   *   still holds something.
   */
  async assertHomeRemovable(roomId: string, options?: { force?: boolean }): Promise<void> {
    if (options?.force) return;
    const stranded = await this.listStrandedWorktrees(roomId);
    if (stranded.length === 0) return;
    throw new RoomError(
      'ROOM_REPO_UNMERGED_WORK',
      `This room still has work nobody has merged, in ${stranded.join(', ')}. Merge it or delete anyway.`
    );
  }

  /**
   * Delete a room's home directory — the on-disk half of a hard delete.
   *
   * Guarded by {@link RoomRepoService.assertHomeRemovable}, so a caller cannot
   * reach the destructive half without answering the unmerged-work question.
   *
   * @param roomId - The room whose files go away.
   * @param options - `force: true` to delete past stranded work.
   */
  async removeHome(roomId: string, options?: { force?: boolean }): Promise<void> {
    await this.assertHomeRemovable(roomId, options);
    await this.#deps.store.removeHomeUnguarded(roomId);
    // The composer's cache outlives the files it read, and a room id can be
    // given files again. Forgetting here is what stops a second `enable` on the
    // same id from serving the deleted repo's conventions until its first
    // commit happens to differ.
    this.#conventions.forget(roomId);
  }

  /**
   * Create the repo and put `ROOM.md` in it, committed as the operator.
   *
   * @param roomId - The room.
   * @param room - Its title and topic, for the seeded file.
   * @param callerAuthorId - Who asked, for the commit author fallback.
   */
  #seedRepo(
    roomId: string,
    room: Room,
    callerAuthorId: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    return originalRepoSeedRepo(this.#operationKey, roomId, room, callerAuthorId, context);
  }

  /**
   * Undo a half-made enable: **the binding first, then the directory**.
   *
   * That order is the whole point, and it is the reverse of what reads
   * naturally. The binding is what every other path believes — `hasRepo`, the
   * next `enable`, the reconciler — so retracting it is the step that must not
   * be skipped. Deleting `repo/` first meant a failing `fs.rm` (a file locked by
   * another process, a permission the server has lost) threw out of the shared
   * `try` and left the sidecar standing: a room advertising files it does not
   * have, permanently.
   *
   * Both cleanup duties are attempted. The caller preserves its first seed failure,
   * including undefined. Only an actually acquired sidecar is retracted; a newly
   * acquired partial repository is quarantined with its bytes retained. An observed
   * existing directory never becomes recursive deletion custody.
   *
   * @param roomId - The room whose enable failed.
   */
  #unwindFailedEnable(roomId: string, context: InstallationRoomMutationContext): Promise<void> {
    return originalRepoUnwindFailedEnable(this.#operationKey, roomId, context);
  }
}

function sameRepoInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
