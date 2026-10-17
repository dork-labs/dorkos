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
import { randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Room } from '@dorkos/shared/room-schemas';
import { type RoomRepoCaps, type RoomRepoSidecar } from '@dorkos/shared/room-repo';
import { RoomError } from '../data/room-errors.js';
import { logger } from '../../../lib/logger.js';
import {
  readOwnedRoomRepoSource,
  executeOriginalRoomRepoStoreRead,
  executeOriginalRoomRepoStoreWrite,
  executeOriginalRoomRepoStoreUpsert,
  rollbackOriginalRoomRepoStoreWrite,
  type RoomRepoStore,
} from './room-repo-store.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';
import {
  commitAll,
  commitsAheadOfMain,
  FALLBACK_OPERATOR_GIT_NAME,
  GitUnavailableError,
  hasUncommittedChanges,
  initRepo,
  OPERATOR_GIT_EMAIL,
  pathsInHead,
  restoreFromHead,
  unstagePaths,
  type StrayChange,
} from './room-repo-git.js';
import { readMainCheckoutState } from './room-main-checkout.js';
import { ROOM_MD_FILENAME, ROOM_MD_SEED_COMMIT_MESSAGE, seedRoomMd } from './room-md.js';
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

/** What the operator asked to do about changes DorkOS did not make. */
export type RoomMainRepair =
  | { action: 'commit' }
  | {
      action: 'discard';
      /**
       * Exactly which files to throw away. Never empty, and every one of them
       * must be a path the room is currently reporting as changed.
       */
      paths: string[];
    };

/** What a repair did, before the room's files are looked at again. */
interface RepairAction {
  /** Which action ran. */
  action: RoomMainRepair['action'];
  /** The commit that kept the changes, or `null` for a discard. */
  commit: string | null;
  /** How many paths it dealt with. */
  paths: number;
}

/** What a repair did. */
export interface RoomMainRepairResult extends RepairAction {
  /**
   * Whether the room's files are clean now.
   *
   * `false` after a discard that named some of the stray changes and not
   * others, which is a legitimate thing to do — and the answer says so rather
   * than letting a client assume merges have resumed.
   */
  clean: boolean;
}

/** What {@link RoomRepoService.enable} answers. */
export interface EnableRoomRepoResult {
  /** `false` when the room already had files and nothing was changed. */
  created: boolean;
  /** The binding — the one just made, or the one that was already there. */
  repo: RoomRepoSidecar;
}

/** The seams {@link RoomRepoService} needs from the rest of the server. */
export interface RoomRepoServiceDeps {
  /** File-first store for the sidecar and its cache row. */
  store: RoomRepoStore;
  /**
   * The per-room serialized queue every server-side write to a room's repo goes
   * through — **the same instance the merge verb uses** (`room-repo-mutex.ts`).
   *
   * Required rather than optional, because what it protects is a check-then-act
   * with an `await` in the middle: see {@link RoomRepoService.enable}. A wiring
   * that forgot it would compile, pass every single-caller test, and lose a
   * room's first commit the first time two callers arrived together.
   */
  mutex: RoomRepoMutex;
  /**
   * How long a caller may wait for the room's queue, in milliseconds
   * (`config.rooms.repo.mergeQueueWaitMs`). Read per call.
   */
  queueWaitMs: () => number;
  /**
   * Whether rooms may have files at all (`config.rooms.repo.enabled`).
   *
   * Read per call, not captured: switching the feature back on has to bind the
   * very next request, not the next server start — the same rule every other
   * live config reader in the rooms domain follows.
   */
  enabled: () => boolean;
  /**
   * The room as this caller can see it, or `null` when they cannot see it at
   * all. `RoomService.getRoom` in production.
   */
  getRoom: (roomId: string, viewerAuthorId: string) => Room | null;
  /** Whether an author is the person who owns this install. */
  isOwnerAuthor: (authorId: string) => boolean;
  /**
   * The name operator commits are authored under, or `null` when this install
   * has no name for them yet.
   */
  operatorGitName: () => string | null;
  /**
   * The caps a NEW binding is created under, seeded from config.
   *
   * Read once at create and then stored on the sidecar, so a later config
   * change cannot retroactively make an existing repo's contents illegal.
   */
  caps: () => RoomRepoCaps;
  /**
   * Put this room's brand-new `ROOM.md` on its canvas, pinned.
   *
   * Called once, after the seed commit, for the room that just got files — which
   * is the one moment a `ROOM.md` starts existing. The notes everybody in the
   * room shares are the one document that is worth a tab by default, and pinning
   * it is what stops a busy room's twelve-document ceiling ever pushing it off.
   *
   * Required rather than optional, for the reason
   * {@link RoomRepoServiceDeps.mutex} is: a wiring that forgot it would compile,
   * pass every test in this file, and quietly give every new room's shared notes
   * no place to be.
   *
   * It must not throw — it is called inside the repo's own queue, and a canvas
   * that refused would unwind a repo that was successfully created.
   */
  pinRoomMd: (roomId: string, authorId: string) => void;
  /**
   * How many bytes of `ROOM.md` may ride a member agent's turn, read LIVE from
   * `config.rooms.repo.maxRoomMdBytes`.
   *
   * Beside {@link RoomRepoServiceDeps.caps} rather than inside it, because the
   * two answer different questions and must be free to disagree. `caps` is
   * frozen onto a room's sidecar at create so a config change cannot make an
   * existing repo's CONTENTS illegal. This one bounds what is SENT, which is a
   * cost paid on every message — somebody who turns it down means the next turn.
   */
  maxRoomMdBytes: () => number;
}

import type { Db } from '@dorkos/db';
import type { RoomStore } from '../room-store.js';
import { requireRoomServiceFileWriteOwner, type RoomService } from '../room-service.js';
import {
  requireInstallationFileWritesOwner,
  type InstallationFileWrites,
} from '../../canvas/doc-channel/writes/installation-file-writes.js';
import type { DocChannelStore } from '../../canvas/doc-channel/store.js';
import {
  requireInstallationRoomWrites,
  readInstallationRoomFileWriteOwner,
  withRecognizedInstallationRoomRepo,
  readInstallationRoomRepoMutationContext,
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomWrites,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  captureDocHttpRoomRepoCaller,
  readDocHttpRoomRepoCaller,
  checkDocHttpRoomRepoCaller,
} from '../../canvas/doc-channel/http-composition.js';
import { DocChannelNotFoundError } from '../../canvas/doc-channel/authorization.js';

interface RoomRepoOwningConstruction {
  readonly owner: InstallationFileWrites;
  readonly writer: InstallationRoomWrites;
  readonly db: Db;
  readonly channels: DocChannelStore;
  readonly rooms: RoomService;
  readonly roomStore: RoomStore;
}
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

/** Enabling, archiving and deleting a room's files. */
export class RoomRepoService {
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
  async #executeEnable(handle: object): Promise<EnableRoomRepoResult> {
    const owning = this.#owning;
    if (!owning) throw new DocChannelNotFoundError();
    this.#requireEnabled();
    const caller = readDocHttpRoomRepoCaller(owning.owner, this, handle, 'enable');
    await checkDocHttpRoomRepoCaller(handle);
    return withRecognizedInstallationRoomRepo(owning.writer, caller.roomId, async (scope) => {
      const context = readInstallationRoomRepoMutationContext(
        owning.writer,
        caller.roomId,
        scope,
        this,
        'enable',
        handle
      );
      originalRepoStoreOperations.set(context, {
        service: this,
        handle,
        owning,
        store: this.#deps.store,
        mutex: this.#deps.mutex,
        roomId: caller.roomId,
        operation: 'enable',
      });
      try {
        return await this.#enableUnderLock(caller.roomId, caller.authorId, context);
      } finally {
        originalRepoStoreOperations.delete(context);
      }
    });
  }

  /**
   * The body of {@link RoomRepoService.enable}, run while holding the room's
   * queue.
   *
   * @param roomId - The room to give files to.
   * @param callerAuthorId - Who is asking.
   * @returns The binding, and whether this call is what made it.
   */
  async #enableUnderLock(
    roomId: string,
    callerAuthorId: string,
    context: InstallationRoomMutationContext
  ): Promise<EnableRoomRepoResult> {
    if (!this.#deps.enabled()) {
      throw new RoomError(
        'ROOM_REPOS_DISABLED',
        'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
      );
    }

    const room = this.#deps.getRoom(roomId, callerAuthorId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');

    if (!this.#deps.isOwnerAuthor(callerAuthorId)) {
      throw new RoomError('OPERATOR_ONLY', 'Only you can give a room files of its own');
    }

    const existing = await executeOriginalRoomRepoStoreRead(
      this.#deps.store,
      this.#owning!.db,
      context,
      roomId
    );
    if (existing) {
      // Write the row back through on the way out: the one case where a caller
      // is looking straight at a binding whose cache row may have been lost.
      executeOriginalRoomRepoStoreUpsert(this.#deps.store, this.#owning!.db, context, existing);
      // **A binding without a repo heals here rather than sticking.** The write
      // order is sidecar-then-git, so a process killed between them leaves a
      // room that reports having files and has none — and answering
      // `created: false` forever would make that permanent, with no path back
      // except deleting the sidecar by hand. Falling through to seed finishes
      // the enable the interrupted call started.
      if (await this.#repoIsInitialised(roomId, context)) {
        requireInstallationRoomMutationTarget(
          context,
          readInstallationRoomMutationRoots(context).repoPath
        );
        this.#requireEnabled();
        requireInstallationRoomMutationTarget(
          context,
          readInstallationRoomMutationRoots(context).repoPath
        );
        return { created: false, repo: existing };
      }
      logger.warn('[rooms] a room repo binding has no repo behind it; finishing the setup', {
        roomId,
      });
      await this.#seedGuarded(roomId, room, callerAuthorId, context);
      await checkInstallationRoomMutationTarget(
        context,
        readInstallationRoomMutationRoots(context).repoPath
      );
      this.#requireEnabled();
      requireInstallationRoomMutationTarget(
        context,
        readInstallationRoomMutationRoots(context).repoPath
      );
      return { created: true, repo: existing };
    }

    const sidecar: RoomRepoSidecar = {
      roomId,
      mode: 'owned',
      createdAt: new Date().toISOString(),
      createdBy: callerAuthorId,
      defaultBranch: 'main',
      caps: this.#deps.caps(),
      lastMergeSeq: null,
    };

    // The same acquired cleanup boundary includes sidecar publication/cache write,
    // not only Git seeding. It remains inside the still-admitted private operation.
    await this.#seedGuarded(roomId, room, callerAuthorId, context, sidecar);
    await checkInstallationRoomMutationTarget(
      context,
      readInstallationRoomMutationRoots(context).repoPath
    );
    this.#requireEnabled();
    requireInstallationRoomMutationTarget(
      context,
      readInstallationRoomMutationRoots(context).repoPath
    );
    return { created: true, repo: sidecar };
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
  async #seedGuarded(
    roomId: string,
    room: Room,
    callerAuthorId: string,
    context: InstallationRoomMutationContext,
    publish?: RoomRepoSidecar
  ): Promise<void> {
    try {
      if (publish)
        await executeOriginalRoomRepoStoreWrite(
          this.#deps.store,
          this.#owning!.db,
          context,
          publish
        );
      await this.#seedRepo(roomId, room, callerAuthorId, context);
    } catch (err) {
      // Attempt all acquired cleanup while preserving the first body failure, including undefined.
      try {
        await this.#unwindFailedEnable(roomId, context);
      } catch {
        /* original failure remains first */
      }
      if (err instanceof GitUnavailableError) {
        throw new RoomError(
          'ROOM_REPO_GIT_UNAVAILABLE',
          'This computer doesn’t have git installed, and a room’s files are a git repository. Install git, then try again.'
        );
      }
      throw err;
    }
    // **Outside the unwind, and guarded on its own.** The repo exists and the
    // seed commit is made; a canvas that refused the tab is a missing tab, not a
    // reason to tear a working repo back down. So this can never reach the
    // `catch` above, and it can never fail the enable either.
    try {
      requireInstallationRoomMutationTarget(
        context,
        readInstallationRoomMutationRoots(context).repoPath
      );
      this.#deps.pinRoomMd(roomId, callerAuthorId);
    } catch (err) {
      logger.warn('[rooms] a new room’s notes did not reach its canvas', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  async #repoIsInitialised(
    roomId: string,
    context?: InstallationRoomMutationContext
  ): Promise<boolean> {
    const owning = this.#owning;
    if (!owning) throw new DocChannelNotFoundError();
    const source = readOwnedRoomRepoSource(this.#deps.store, owning.db, roomId);
    const repo = context ? readInstallationRoomMutationRoots(context).repoPath : source.repo;
    if (repo !== source.repo) throw new DocChannelNotFoundError();
    const target = path.join(repo, '.git');
    if (context) await checkInstallationRoomMutationTarget(context, target);
    let present = false;
    try {
      await fs.lstat(target);
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    const current = readOwnedRoomRepoSource(this.#deps.store, owning.db, roomId);
    if (
      current.repo !== source.repo ||
      current.root !== source.root ||
      JSON.stringify(current.row) !== JSON.stringify(source.row)
    )
      throw new DocChannelNotFoundError();
    if (context) await checkInstallationRoomMutationTarget(context, target);
    return present;
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

  async #executeRepair(handle: object, repair: RoomMainRepair): Promise<RoomMainRepairResult> {
    const owning = this.#owning;
    if (!owning) throw new DocChannelNotFoundError();
    const caller = readDocHttpRoomRepoCaller(owning.owner, this, handle, 'repair');
    const roomId = caller.roomId,
      callerAuthorId = caller.authorId;
    await checkDocHttpRoomRepoCaller(handle);
    if (!this.#deps.enabled()) {
      throw new RoomError(
        'ROOM_REPOS_DISABLED',
        'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
      );
    }
    // The room first, so a caller who cannot see it learns nothing else; then
    // the operator gate — the same order `enable` takes.
    if (!this.#deps.getRoom(roomId, callerAuthorId)) {
      throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    }
    if (!this.#deps.isOwnerAuthor(callerAuthorId)) {
      throw new RoomError('OPERATOR_ONLY', 'Only you can decide what happens to those changes');
    }
    if (
      readOwnedRoomRepoSource(this.#deps.store, owning.db, roomId).row === null ||
      !(await this.#repoIsInitialised(roomId))
    ) {
      throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
    }

    await checkDocHttpRoomRepoCaller(handle);
    this.#requireEnabled();
    return withRecognizedInstallationRoomRepo(owning.writer, roomId, async (scope) => {
      const context = readInstallationRoomRepoMutationContext(
        owning.writer,
        roomId,
        scope,
        this,
        'repair',
        handle
      );
      originalRepoStoreOperations.set(context, {
        service: this,
        handle,
        owning,
        store: this.#deps.store,
        mutex: this.#deps.mutex,
        roomId,
        operation: 'repair',
      });
      try {
        return await this.#repairUnderLock(roomId, repair, context);
      } finally {
        originalRepoStoreOperations.delete(context);
      }
    });
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
  async #repairUnderLock(
    roomId: string,
    repair: RoomMainRepair,
    context: InstallationRoomMutationContext
  ): Promise<RoomMainRepairResult> {
    const { repoPath: repoDir, homePath: ceiling } = readInstallationRoomMutationRoots(context);
    try {
      await checkInstallationRoomMutationTarget(context, repoDir);
      const state = await readMainCheckoutState(repoDir, ceiling);
      await checkInstallationRoomMutationTarget(context, repoDir);
      if (state.branch !== 'main') {
        throw new RoomError(
          'MAIN_CHECKOUT_DIRTY',
          `This room’s files are on ${state.branch ?? 'no branch'} rather than main, which only something outside DorkOS can have done. Put them back on main yourself — DorkOS will not move a branch it did not move, in case there is work on it.`
        );
      }

      const result =
        repair.action === 'commit'
          ? await this.#keepStrayChanges(repoDir, ceiling, state.strays.length, context)
          : await this.#discardStrayChanges(repoDir, ceiling, state.strays, repair.paths, context);

      const after = await readMainCheckoutState(repoDir, ceiling);
      await checkInstallationRoomMutationTarget(context, repoDir);
      requireInstallationRoomMutationTarget(context, repoDir);
      logger.info('[rooms] a room’s stray file changes were dealt with', {
        roomId,
        action: repair.action,
        paths: result.paths,
      });
      this.#requireEnabled();
      requireInstallationRoomMutationTarget(context, repoDir);
      return { ...result, clean: after.strays.length === 0 };
    } catch (err) {
      if (err instanceof GitUnavailableError) {
        throw new RoomError(
          'ROOM_REPO_GIT_UNAVAILABLE',
          'This computer doesn’t have git installed, and a room’s files are a git repository. Install git, then try again.'
        );
      }
      throw err;
    }
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
  async #keepStrayChanges(
    repoDir: string,
    ceiling: string,
    strayCount: number,
    context: InstallationRoomMutationContext
  ): Promise<RepairAction> {
    if (strayCount === 0) return { action: 'commit', commit: null, paths: 0 };
    const commit = await commitAll(
      repoDir,
      STRAY_CHANGES_COMMIT_MESSAGE,
      {
        name: this.#deps.operatorGitName() ?? FALLBACK_OPERATOR_GIT_NAME,
        email: OPERATOR_GIT_EMAIL,
      },
      ceiling,
      context
    );
    return { action: 'commit', commit, paths: strayCount };
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
  async #discardStrayChanges(
    repoDir: string,
    ceiling: string,
    strays: readonly StrayChange[],
    paths: readonly string[],
    context: InstallationRoomMutationContext
  ): Promise<RepairAction> {
    const reported = new Map(strays.map((stray) => [stray.path, stray]));
    for (const filePath of paths) {
      if (!reported.has(filePath)) {
        throw new RoomError(
          'ROOM_FILE_NOT_FOUND',
          `\`${filePath}\` is not one of the changes waiting in this room’s files. Look again — it may already have been dealt with.`
        );
      }
    }

    const wanted = [...new Set(paths)];
    // The name a rename came FROM is restored with it. It was never offered as
    // a stray of its own (it is not there to discard), and it is not counted as
    // one either — the answer says how many changes the operator named.
    const alsoRestore = wanted
      .map((filePath) => reported.get(filePath)?.renamedFrom)
      .filter((from): from is string => from !== undefined);
    const inHead = await pathsInHead(repoDir, [...wanted, ...alsoRestore], ceiling);
    const restore = [...new Set([...wanted, ...alsoRestore])].filter((filePath) =>
      inHead.has(filePath)
    );
    const remove = wanted.filter((filePath) => !inHead.has(filePath));

    await restoreFromHead(repoDir, restore, ceiling, context);
    if (remove.length > 0) {
      // The files first, then the index — see {@link unstagePaths} for why that
      // order is what lets this run without a force flag.
      for (const filePath of remove) {
        const target = path.join(repoDir, filePath);
        // Git's own output cannot climb out of the repo, and this is the line
        // that says so rather than assuming it. `fs.rm` does not follow a
        // symlink, so a link named here is unlinked and never followed.
        if (target !== repoDir && !target.startsWith(`${repoDir}${path.sep}`)) continue;
        await checkInstallationRoomMutationTarget(context, target);
        let acquired: Stats | undefined;
        try {
          acquired = await fs.lstat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
        if (!acquired) continue;
        // An observed directory is never recursive file-removal custody.
        if (acquired.isDirectory())
          throw new RoomError(
            'ROOM_FILE_NOT_FOUND',
            'That change is a directory, not a file to discard.'
          );
        const parentPath = path.dirname(target),
          parent = await fs.lstat(parentPath);
        if (!parent.isDirectory() || parent.isSymbolicLink())
          throw new Error('Room discard parent is not its actual directory.');
        await checkInstallationRoomMutationTarget(context, target);
        if (
          !sameRepoInode(acquired, await fs.lstat(target)) ||
          !sameRepoInode(parent, await fs.lstat(parentPath))
        )
          throw new Error('Room discard refuses a replaced file/parent.');
        requireInstallationRoomMutationTarget(context, target);
        await fs.unlink(target);
        await checkInstallationRoomMutationTarget(context, repoDir);
      }
      await unstagePaths(repoDir, remove, ceiling, context);
    }
    return { action: 'discard', commit: null, paths: wanted.length };
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
  async #seedRepo(
    roomId: string,
    room: Room,
    callerAuthorId: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    const roots = readInstallationRoomMutationRoots(context),
      repoDir = roots.repoPath,
      ceiling = roots.homePath;
    const seed = seedRoomMd({ title: room.title, topic: room.topic });
    const gitAuthor = {
      name: this.#deps.operatorGitName() ?? FALLBACK_OPERATOR_GIT_NAME,
      email: OPERATOR_GIT_EMAIL,
    };
    await checkInstallationRoomMutationTarget(context, repoDir);
    const home = await fs.lstat(ceiling);
    if (!home.isDirectory() || home.isSymbolicLink())
      throw new Error('Room seed home is not its actual directory.');
    let previousRepo: Stats | undefined;
    try {
      previousRepo = await fs.lstat(repoDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await checkInstallationRoomMutationTarget(context, repoDir);
    if (!sameRepoInode(home, await fs.lstat(ceiling)))
      throw new Error('Room seed home replaced before acquisition.');
    requireInstallationRoomMutationTarget(context, repoDir);
    if (!previousRepo) await fs.mkdir(repoDir);
    const repo = await fs.lstat(repoDir);
    if (
      !repo.isDirectory() ||
      repo.isSymbolicLink() ||
      (previousRepo && !sameRepoInode(previousRepo, repo))
    )
      throw new Error('Room seed repository replaced before acquisition.');
    if (!previousRepo)
      this.#acquiredSeedRepos.set(context, {
        roomId,
        home: ceiling,
        homeStat: home,
        repo: repoDir,
        repoStat: repo,
      });
    await checkInstallationRoomMutationTarget(context, repoDir);
    await initRepo(repoDir, ceiling, context);
    await checkInstallationRoomMutationTarget(context, repoDir);
    if (
      !sameRepoInode(home, await fs.lstat(ceiling)) ||
      !sameRepoInode(repo, await fs.lstat(repoDir))
    )
      throw new Error('Room seed repository replaced during native initialization.');
    const target = path.join(repoDir, ROOM_MD_FILENAME),
      tmp = path.join(repoDir, `.${randomUUID()}.seed.tmp`);
    let previousTarget: Stats | undefined;
    try {
      previousTarget = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    if (previousTarget && (!previousTarget.isFile() || previousTarget.isSymbolicLink()))
      throw new Error('Room seed destination is not its regular file.');
    let handle: FileHandle | undefined, acquired: Stats | undefined;
    let failed = false,
      cause: unknown;
    // Join this scope to its captured cleanup before returning or reporting failure.
    const drainOriginalCleanup = async () => {
      if (handle) {
        try {
          await handle.close();
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
      }
      if (acquired) {
        try {
          let current: Stats | undefined;
          try {
            current = await fs.lstat(tmp);
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
          }
          if (current) {
            if (
              !sameRepoInode(acquired, current) ||
              !sameRepoInode(repo, await fs.lstat(repoDir)) ||
              !sameRepoInode(home, await fs.lstat(ceiling))
            )
              throw new Error('Room seed cleanup refuses a foreign file/parent.');
            if (!readOriginalRoomRepoCleanupOperation(context, this.#deps.store, this.#owning!.db))
              throw new Error('Room seed cleanup is retired.');
            await fs.unlink(tmp);
          }
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
      }
    };
    try {
      await checkInstallationRoomMutationTarget(context, tmp);
      if (
        !sameRepoInode(home, await fs.lstat(ceiling)) ||
        !sameRepoInode(repo, await fs.lstat(repoDir))
      )
        throw new Error('Room seed acquisition lost its parent.');
      requireInstallationRoomMutationTarget(context, tmp);
      handle = await fs.open(
        tmp,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600
      );
      acquired = await handle.stat();
      if (!acquired.isFile()) throw new Error('Room seed acquisition is not a regular file.');
      await checkInstallationRoomMutationTarget(context, tmp);
      await handle.writeFile(seed, 'utf8');
      await checkInstallationRoomMutationTarget(context, tmp);
      await handle.sync();
      await checkInstallationRoomMutationTarget(context, target);
      let currentTarget: Stats | undefined;
      try {
        currentTarget = await fs.lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      if (
        (previousTarget === undefined) !== (currentTarget === undefined) ||
        (previousTarget &&
          currentTarget &&
          (!currentTarget.isFile() ||
            currentTarget.isSymbolicLink() ||
            !sameRepoInode(previousTarget, currentTarget)))
      )
        throw new Error('Room seed destination replaced before publication.');
      if (
        !sameRepoInode(acquired, await handle.stat()) ||
        !sameRepoInode(acquired, await fs.lstat(tmp)) ||
        !sameRepoInode(repo, await fs.lstat(repoDir)) ||
        !sameRepoInode(home, await fs.lstat(ceiling))
      )
        throw new Error('Room seed publication lost its acquired file/parent.');
      requireInstallationRoomMutationTarget(context, target);
      await fs.rename(tmp, target);
      await checkInstallationRoomMutationTarget(context, target);
      if (
        !sameRepoInode(acquired, await fs.lstat(target)) ||
        !sameRepoInode(repo, await fs.lstat(repoDir))
      )
        throw new Error('Room seed readback lost its acquired publication.');
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
      await drainOriginalCleanup();
    }
    if (failed) throw cause;
    await checkInstallationRoomMutationTarget(context, repoDir);
    if (
      !sameRepoInode(home, await fs.lstat(ceiling)) ||
      !sameRepoInode(repo, await fs.lstat(repoDir))
    )
      throw new Error('Room seed commit lost its acquired parent.');
    requireInstallationRoomMutationTarget(context, repoDir);
    await commitAll(repoDir, ROOM_MD_SEED_COMMIT_MESSAGE, gitAuthor, ceiling, context);
    await checkInstallationRoomMutationTarget(context, repoDir);
    this.#acquiredSeedRepos.delete(context);
    logger.info('[rooms] room repo created', { roomId, createdBy: callerAuthorId });
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
  async #unwindFailedEnable(
    roomId: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    let failed = false,
      cause: unknown;
    try {
      await rollbackOriginalRoomRepoStoreWrite(this.#deps.store, this.#owning!.db, context);
    } catch (error) {
      failed = true;
      cause = error;
    }
    const acquired = this.#acquiredSeedRepos.get(context);
    if (acquired) {
      // Preserve a partial native repository as a quarantine. Recursive pathname deletion
      // cannot prove ownership of every child written by Git or an external process.
      const quarantine = `${acquired.repo}.failed-${randomUUID()}`;
      let reservation: Stats | undefined,
        published = false;
      // Join this scope to its captured cleanup before returning or reporting failure.
      const drainOriginalCleanup = async () => {
        if (reservation && !published) {
          try {
            if (
              !sameRepoInode(acquired.homeStat, await fs.lstat(acquired.home)) ||
              !sameRepoInode(reservation, await fs.lstat(quarantine))
            )
              throw new Error('Room seed reservation cleanup refuses a foreign directory/parent.');
            if (!readOriginalRoomRepoCleanupOperation(context, this.#deps.store, this.#owning!.db))
              throw new Error('Room seed cleanup is retired.');
            await fs.rmdir(quarantine);
          } catch (error) {
            if (!failed) {
              failed = true;
              cause = error;
            }
          }
        }
      };
      try {
        if (
          !readOriginalRoomRepoCleanupOperation(context, this.#deps.store, this.#owning!.db) ||
          acquired.roomId !== roomId
        )
          throw new Error('Room seed cleanup is foreign or retired.');
        if (
          !sameRepoInode(acquired.homeStat, await fs.lstat(acquired.home)) ||
          !sameRepoInode(acquired.repoStat, await fs.lstat(acquired.repo))
        )
          throw new Error('Room seed cleanup refuses a foreign repository/parent.');
        await fs.mkdir(quarantine);
        reservation = await fs.lstat(quarantine);
        if (!reservation.isDirectory() || reservation.isSymbolicLink())
          throw new Error('Room seed quarantine is not its acquired reservation.');
        if (
          !sameRepoInode(acquired.homeStat, await fs.lstat(acquired.home)) ||
          !sameRepoInode(acquired.repoStat, await fs.lstat(acquired.repo)) ||
          !sameRepoInode(reservation, await fs.lstat(quarantine))
        )
          throw new Error('Room seed quarantine refuses observed replacement.');
        if (!readOriginalRoomRepoCleanupOperation(context, this.#deps.store, this.#owning!.db))
          throw new Error('Room seed cleanup retired before quarantine.');
        await fs.rename(acquired.repo, quarantine);
        published = true;
        if (!sameRepoInode(acquired.repoStat, await fs.lstat(quarantine)))
          throw new Error('Room seed quarantine lost its acquired repository.');
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      } finally {
        await drainOriginalCleanup();
      }
      this.#acquiredSeedRepos.delete(context);
    }
    if (failed) throw cause;
  }
}

function sameRepoInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
