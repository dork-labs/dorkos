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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Room } from '@dorkos/shared/room-schemas';
import { type RoomRepoCaps, type RoomRepoSidecar } from '@dorkos/shared/room-repo';
import { RoomError } from '../room-errors.js';
import { logger } from '../../../lib/logger.js';
import type { RoomRepoStore } from './room-repo-store.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';
import {
  commitAll,
  commitsAheadOfMain,
  FALLBACK_OPERATOR_GIT_NAME,
  GitUnavailableError,
  hasUncommittedChanges,
  initRepo,
  OPERATOR_GIT_EMAIL,
} from './room-repo-git.js';
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

/** Enabling, archiving and deleting a room's files. */
export class RoomRepoService {
  /**
   * The `ROOM.md` composer, built here because it needs exactly what this
   * service already holds: the store's paths, the feature flag, and the live
   * delivery cap. Callers reach it through
   * {@link RoomRepoService.conventionsFor}.
   */
  private readonly conventions: RoomConventions;

  constructor(private readonly deps: RoomRepoServiceDeps) {
    this.conventions = new RoomConventions({
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
    return this.conventions.compose(room);
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
  enable(roomId: string, callerAuthorId: string): Promise<EnableRoomRepoResult> {
    return this.deps.mutex.run(
      roomId,
      {
        waitMs: this.deps.queueWaitMs(),
        busy: () =>
          new RoomError(
            'MERGE_IN_FLIGHT',
            'This room’s files are busy — something else is writing to them. Try again in a moment.'
          ),
      },
      () => this.enableUnderLock(roomId, callerAuthorId)
    );
  }

  /**
   * The body of {@link RoomRepoService.enable}, run while holding the room's
   * queue.
   *
   * @param roomId - The room to give files to.
   * @param callerAuthorId - Who is asking.
   * @returns The binding, and whether this call is what made it.
   */
  private async enableUnderLock(
    roomId: string,
    callerAuthorId: string
  ): Promise<EnableRoomRepoResult> {
    if (!this.deps.enabled()) {
      throw new RoomError(
        'ROOM_REPOS_DISABLED',
        'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
      );
    }

    const room = this.deps.getRoom(roomId, callerAuthorId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');

    if (!this.deps.isOwnerAuthor(callerAuthorId)) {
      throw new RoomError('OPERATOR_ONLY', 'Only you can give a room files of its own');
    }

    const existing = await this.deps.store.readSidecar(roomId);
    if (existing) {
      // Write the row back through on the way out: the one case where a caller
      // is looking straight at a binding whose cache row may have been lost.
      this.deps.store.upsertRow(existing);
      // **A binding without a repo heals here rather than sticking.** The write
      // order is sidecar-then-git, so a process killed between them leaves a
      // room that reports having files and has none — and answering
      // `created: false` forever would make that permanent, with no path back
      // except deleting the sidecar by hand. Falling through to seed finishes
      // the enable the interrupted call started.
      if (await this.repoIsInitialised(roomId)) {
        return { created: false, repo: existing };
      }
      logger.warn('[rooms] a room repo binding has no repo behind it; finishing the setup', {
        roomId,
      });
      await this.seedGuarded(roomId, room, callerAuthorId);
      return { created: true, repo: existing };
    }

    const sidecar: RoomRepoSidecar = {
      roomId,
      mode: 'owned',
      createdAt: new Date().toISOString(),
      createdBy: callerAuthorId,
      defaultBranch: 'main',
      caps: this.deps.caps(),
      lastMergeSeq: null,
    };

    await this.deps.store.write(sidecar);
    await this.seedGuarded(roomId, room, callerAuthorId);
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
  private async seedGuarded(roomId: string, room: Room, callerAuthorId: string): Promise<void> {
    try {
      await this.seedRepo(roomId, room, callerAuthorId);
    } catch (err) {
      await this.unwindFailedEnable(roomId);
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
   * Whether the repo behind a binding actually exists.
   *
   * Asks for `.git` rather than running a git command: this runs on the enable
   * path, the answer is a yes/no about a directory, and spawning a process to
   * learn it would put a process spawn in front of every repeat call.
   *
   * @param roomId - The room.
   */
  private async repoIsInitialised(roomId: string): Promise<boolean> {
    try {
      await fs.stat(path.join(this.deps.store.repoPath(roomId), '.git'));
      return true;
    } catch {
      return false;
    }
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
    return this.deps.enabled() && this.deps.store.getRow(roomId) !== null;
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
    const root = this.deps.store.worktreesPath(roomId);
    // Git's repository search may not climb past the room's own home. Without
    // it, a directory under `worktrees/` that is NOT a checkout answers for
    // whatever repository encloses the DorkOS data directory — in dev, the
    // dorkos checkout — and this guard would call somebody's stranded work
    // clean. See `room-repo-git.ts`.
    const ceiling = this.deps.store.homeDir(roomId);
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
    await this.deps.store.removeHomeUnguarded(roomId);
    // The composer's cache outlives the files it read, and a room id can be
    // given files again. Forgetting here is what stops a second `enable` on the
    // same id from serving the deleted repo's conventions until its first
    // commit happens to differ.
    this.conventions.forget(roomId);
  }

  /**
   * Create the repo and put `ROOM.md` in it, committed as the operator.
   *
   * @param roomId - The room.
   * @param room - Its title and topic, for the seeded file.
   * @param callerAuthorId - Who asked, for the commit author fallback.
   */
  private async seedRepo(roomId: string, room: Room, callerAuthorId: string): Promise<void> {
    const repoDir = this.deps.store.repoPath(roomId);
    const ceiling = this.deps.store.homeDir(roomId);
    await fs.mkdir(repoDir, { recursive: true });
    await initRepo(repoDir, ceiling);
    await fs.writeFile(
      path.join(repoDir, ROOM_MD_FILENAME),
      seedRoomMd({ title: room.title, topic: room.topic }),
      'utf-8'
    );
    await commitAll(
      repoDir,
      ROOM_MD_SEED_COMMIT_MESSAGE,
      {
        name: this.deps.operatorGitName() ?? FALLBACK_OPERATOR_GIT_NAME,
        email: OPERATOR_GIT_EMAIL,
      },
      ceiling
    );
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
   * Each step gets its own `try` for the same reason. Failures are logged
   * rather than thrown — the caller is already throwing the reason the enable
   * failed, and replacing it with a cleanup error would hide the thing that
   * actually went wrong.
   *
   * @param roomId - The room whose enable failed.
   */
  private async unwindFailedEnable(roomId: string): Promise<void> {
    try {
      await this.deps.store.remove(roomId);
    } catch (err) {
      logger.error('[rooms] could not retract a failed room-repo binding', { roomId, err });
    }
    try {
      await fs.rm(this.deps.store.repoPath(roomId), { recursive: true, force: true });
    } catch (err) {
      logger.error('[rooms] could not remove a half-made room repo', { roomId, err });
    }
  }
}
