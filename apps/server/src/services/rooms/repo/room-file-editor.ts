/**
 * A person editing a room's files (spec `project-rooms` §3.10).
 *
 * The room's integration tree has one writer, and until now that writer only
 * ever merged. This is the second thing it does: **one save is one commit,
 * authored as the person who typed it, made in `repo/` under the same queue a
 * merge takes.** An agent has a working copy and a merge for this; a person has
 * an editor and this route, and neither can write where the other does.
 *
 * ## The lock is about the FILE, not about the room
 *
 * A save carries the commit its editor read the file at (`baseCommit`). The
 * obvious check — refuse if `main` moved — is the wrong one: `main` moves every
 * time anybody merges anything, so a room with active agents would refuse most
 * saves for a reason that has nothing to do with the file being saved. So the
 * question asked is narrower and is the one that matters: **did this PATH change
 * between the commit the editor read and the commit `main` points at now?** Same
 * blob, same mode — the save goes in, whatever else landed. Different — the save
 * is refused with `FILE_CHANGED` and the current commit, and a person decides
 * whether to reload or to overwrite.
 *
 * That refusal carries a payload, so it is a RESULT rather than a `RoomError`,
 * exactly as `ROOM_REPO_EXISTS` is: a code and a sentence have nowhere to put
 * the commit the client has to act on. See {@link RoomFileSaveOutcome}.
 *
 * ## A write goes to disk, so the checks a read does not need are here
 *
 * `room-files.ts` reads out of a COMMIT, where `.git` cannot appear and a
 * symlink is a value nobody follows. A write lands in a real checkout, where
 * both are doors:
 *
 * - **`.git` in any spelling is refused** ({@link assertWritablePath}) —
 *   lower-cased, because APFS and NTFS open `.GIT/config` as `.git/config`, and
 *   `repo/.git` is the common directory every worktree of the room shares.
 * - **No ancestor of the target may be a symlink on disk**, and the target
 *   itself is opened `O_NOFOLLOW`. A link in the TREE is already refused by the
 *   tree checks, but a link that is not in the tree at all — untracked and
 *   hidden from `git status` by a member-written `.gitignore` — is not, and it
 *   would otherwise be followed straight out of the room.
 * - **The tree entry at the path must be an ordinary file**: a directory, a
 *   symlink and a submodule are each refused rather than overwritten.
 * - **New directories are not created.** A save writes into a folder the room
 *   already has, or into the root. Creating a path means creating the folders
 *   above it, which is the one act that would have to walk ground it has not
 *   checked; a room grows folders through an agent's work, where a whole tool
 *   set is watching.
 *
 * ## Nothing is left half-done
 *
 * The write and the commit are one act. If the commit fails, the file is put
 * back the way `HEAD` has it (or removed, when `HEAD` never had it) before the
 * failure is reported — because a tree left dirty stops every merge in the room
 * with `MAIN_CHECKOUT_DIRTY`, and a save that fails must not be the thing that
 * wedges a room.
 *
 * @module server/services/rooms/repo/room-file-editor
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { RoomRepoCaps } from '@dorkos/shared/room-repo';
import type {
  RoomFileCommit,
  RoomFileConflict,
  RoomFileSaveResponse,
} from '@dorkos/shared/room-files';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../room-errors.js';
import { normalizeRoomFilePath } from './room-files.js';
import type { RoomRepoStore } from './room-repo-store.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';
import { assertMainCheckoutReady } from './room-main-checkout.js';
import {
  commitStaged,
  FALLBACK_OPERATOR_GIT_NAME,
  GitUnavailableError,
  hasStagedChanges,
  listTree,
  isIgnored,
  OPERATOR_GIT_EMAIL,
  restoreFromHead,
  revParse,
  stagePaths,
  SYMLINK_MODE,
  GITLINK_MODE,
  unstagePaths,
  type TreeEntry,
} from './room-repo-git.js';

/**
 * Spellings of `.git` that a case-insensitive or 8.3-aware filesystem opens as
 * the real thing.
 *
 * The same list `room-merge-service.ts` refuses symlinks into, and refused here
 * for the same measured reason: `.GIT/config` and `.Git/hooks/pre-commit` open
 * exactly the files `.git/config` and `.git/hooks/pre-commit` open on APFS and
 * NTFS, and in `repo/` those are real — `.git/config` is the common directory
 * shared by every worktree of the room, and `hooks/` is code the next git
 * command would run. A trailing dot and the 8.3 alias `git~1` are NTFS's other
 * two doors to the same place.
 *
 * Kept beside the write path rather than shared with the merge service, because
 * the two ask different questions of it: that one asks where a symlink POINTS,
 * this one asks what a path NAMES, and folding them into one helper would make
 * a change for one silently a change for the other.
 */
const GIT_DIR_SPELLINGS: readonly string[] = ['.git', '.git.', 'git~1'];

/**
 * `O_NOFOLLOW` where the platform has it, and nothing where it does not.
 *
 * The final component of a save is opened with it, so a symlink that appears
 * between the check and the write is refused by the KERNEL rather than
 * followed. Windows has no such flag and no symlinks without a privilege, so
 * there it is zero and the lstat walk is the whole guard.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** What a save answers: it landed, or the file moved underneath it. */
export type RoomFileSaveOutcome =
  | { status: 'saved'; result: RoomFileSaveResponse }
  | { status: 'conflict'; conflict: RoomFileConflict };

/** The seams {@link RoomFileEditor} needs from the rest of the server. */
export interface RoomFileEditorDeps {
  /** Owns every path under a room's home; never construct one by hand. */
  store: RoomRepoStore;
  /** The per-room serialized queue every write to `repo/` goes through. */
  mutex: RoomRepoMutex;
  /** `config.rooms.repo.enabled`, read per call. */
  enabled(): boolean;
  /** `config.rooms.repo.mergeQueueWaitMs`, read per call. */
  queueWaitMs(): number;
  /**
   * Refuse anybody who may not save a file in this room.
   *
   * `RoomService.assertCanWriteFiles` in production: a member, not archived,
   * and a person — an agent has its own working copy and a merge, and a second
   * write path into the integration tree is the one-writer rule undone.
   */
  assertCanWriteFiles(roomId: string, authorId: string): void;
  /**
   * The name a person's commit is authored under, or `null` when this install
   * has no name for them yet. `RoomRepoService`'s own seam, shared so that
   * `git log` in a room reads with one voice.
   */
  operatorGitName(): string | null;
  /**
   * Who last touched a file — `RoomFilesService` in production.
   *
   * The same service the room's explorer reads through, so a save's answer and
   * an explorer row can never describe one file two ways. Narrowed to the one
   * method a save needs, because that is all the coupling there is.
   */
  files: RoomFileProvenanceReader;
}

/** The one thing a save needs from the read side. */
interface RoomFileProvenanceReader {
  /**
   * Who last touched one file on `main`.
   *
   * @param roomId - The room.
   * @param filePath - The file, relative to the repo root.
   */
  lastCommitFor(roomId: string, filePath: string): Promise<RoomFileCommit | null>;
}

/** Saving one file into a room's `main`, as the person who typed it. */
export class RoomFileEditor {
  constructor(private readonly deps: RoomFileEditorDeps) {}

  /**
   * Save one file into the room's `main`, as one commit.
   *
   * Authorization is answered before the queue and git state inside it — the
   * same ordering `RoomMergeService.merge` writes down, and for the same reason:
   * who may save does not change while a caller waits, while everything git can
   * say does.
   *
   * @param roomId - The room whose files are being edited.
   * @param callerAuthorId - Who is asking. Must be a person on the roster.
   * @param input.path - The file, relative to the repo root.
   * @param input.baseCommit - The commit the editor read the file at, or `null`
   *   when the repo had no commits.
   * @param input.text - The file's whole new contents.
   * @returns The save, or the conflict that stopped it.
   * @throws {RoomError} `ROOM_REPOS_DISABLED`, `ROOM_NOT_FOUND`,
   *   `ROOM_ARCHIVED`, `PEOPLE_ONLY`, `ROOM_HAS_NO_REPO`,
   *   `ROOM_FILE_PATH_INVALID`, `ROOM_FILE_NOT_FOUND`,
   *   `ROOM_FILE_NOT_READABLE`, `ROOM_FILE_NOT_TEXT`, `FILE_TOO_LARGE`,
   *   `REPO_CAP_EXCEEDED`, `MAIN_CHECKOUT_DIRTY`, `MERGE_IN_FLIGHT`, or
   *   `ROOM_REPO_GIT_UNAVAILABLE`.
   */
  async save(
    roomId: string,
    callerAuthorId: string,
    input: { path: string; baseCommit: string | null; text: string }
  ): Promise<RoomFileSaveOutcome> {
    if (!this.deps.enabled()) {
      throw new RoomError(
        'ROOM_REPOS_DISABLED',
        'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
      );
    }
    // Membership before anything about the repo, so a non-member cannot tell a
    // project room from any other — the order `GET /:id/files` writes down.
    this.deps.assertCanWriteFiles(roomId, callerAuthorId);
    if (this.deps.store.getRow(roomId) === null) {
      throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
    }

    const filePath = normalizeRoomFilePath(input.path);
    if (filePath === '') {
      throw new RoomError('ROOM_FILE_NOT_READABLE', 'That is the whole room, not a file in it.');
    }
    assertWritablePath(filePath);

    return this.deps.mutex.run(
      roomId,
      {
        waitMs: this.deps.queueWaitMs(),
        busy: () =>
          new RoomError(
            'MERGE_IN_FLIGHT',
            'Someone else is writing to this room’s files right now, and the wait ran out. Try saving again in a moment.'
          ),
        queueFull: () =>
          new RoomError(
            'MERGE_IN_FLIGHT',
            'This room’s files already have as many changes queued as they will hold. Wait for them to land, then save again.'
          ),
      },
      () => this.saveUnderLock(roomId, filePath, input.baseCommit, input.text)
    );
  }

  /**
   * Everything that reads git, the write, and the commit — all while holding
   * the room's lane.
   *
   * @param roomId - The room.
   * @param filePath - The normalised repo-relative path.
   * @param baseCommit - What the editor read the file at.
   * @param text - The new contents.
   */
  private async saveUnderLock(
    roomId: string,
    filePath: string,
    baseCommit: string | null,
    text: string
  ): Promise<RoomFileSaveOutcome> {
    const repoDir = this.deps.store.repoPath(roomId);
    const ceiling = this.deps.store.homeDir(roomId);
    const caps = await this.requireCaps(roomId);

    return this.translatingGitAbsence(async () => {
      await assertMainCheckoutReady(repoDir, ceiling);

      const head = await this.resolveMain(repoDir, ceiling);
      const tree = head ? await listTree(repoDir, head, ceiling) : new Map<string, TreeEntry>();
      const existing = tree.get(filePath) ?? null;

      this.assertOverwritable(filePath, existing, tree);
      this.assertParentExists(filePath, tree);
      await assertNotIgnored(repoDir, ceiling, filePath);

      const conflict = await this.checkLock(
        roomId,
        repoDir,
        ceiling,
        filePath,
        head,
        baseCommit,
        existing
      );
      if (conflict) return { status: 'conflict' as const, conflict };

      const bytes = Buffer.from(text, 'utf-8');
      assertText(filePath, bytes);
      this.assertFits(filePath, bytes.length, tree, caps);

      await assertNoLinkOnDisk(repoDir, filePath);

      const committed = await this.writeAndCommit(
        repoDir,
        ceiling,
        filePath,
        bytes,
        existing !== null
      );
      // `head` is only ever `null` for a repo with no commits, and a save into
      // one always stages something — so the fallback is unreachable except
      // where `committed` is a real sha.
      const commit = committed ?? head ?? '';

      return {
        status: 'saved' as const,
        result: {
          path: filePath,
          commit,
          size: bytes.length,
          committed: committed !== null,
          lastCommit: await this.lastCommitOf(roomId, filePath),
        },
      };
    });
  }

  /**
   * Write the file and commit it, undoing the write if the commit fails.
   *
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   * @param filePath - The normalised repo-relative path.
   * @param bytes - The contents to write.
   * @param existed - Whether `main` already held this file, which decides both
   *   the commit's own wording and how a failure is undone.
   * @returns The new commit, or `null` when the text was already what the file
   *   held and nothing needed committing.
   */
  private async writeAndCommit(
    repoDir: string,
    ceiling: string,
    filePath: string,
    bytes: Buffer,
    existed: boolean
  ): Promise<string | null> {
    // `O_NOFOLLOW` on the final component: the lstat walk above cannot close
    // the window between looking and writing, and the kernel can.
    const handle = await fs.open(
      path.join(repoDir, filePath),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW,
      0o644
    );
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }

    try {
      await stagePaths(repoDir, [filePath], ceiling);
      // A person saving a file they did not change is a normal thing to do, and
      // git refuses an empty commit. Nothing is written, and the answer says so.
      if (!(await hasStagedChanges(repoDir, ceiling))) return null;
      return await commitStaged(
        repoDir,
        commitSubject(filePath, existed),
        {
          name: this.deps.operatorGitName() ?? FALLBACK_OPERATOR_GIT_NAME,
          email: OPERATOR_GIT_EMAIL,
        },
        ceiling
      );
    } catch (err) {
      // The tree must not be left dirty: every merge in the room refuses while
      // it is, so a failed save would wedge the room for everybody.
      await this.rollback(repoDir, ceiling, filePath, existed);
      throw err;
    }
  }

  /**
   * Put one path back the way `main` had it, after a save that could not finish.
   *
   * Best-effort and never throws: the caller is already reporting the reason the
   * save failed, and replacing it with a cleanup error would hide it. A rollback
   * that fails is logged loudly, because what it leaves behind is exactly the
   * dirty-main state the operator will be asked about.
   *
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   * @param filePath - The path that was written.
   * @param existed - Whether `main` held the file before the save.
   */
  private async rollback(
    repoDir: string,
    ceiling: string,
    filePath: string,
    existed: boolean
  ): Promise<void> {
    try {
      if (existed) {
        await restoreFromHead(repoDir, [filePath], ceiling);
        return;
      }
      // The file first, then the index — see {@link unstagePaths} for why that
      // order is what lets this run without a force flag.
      await fs.rm(path.join(repoDir, filePath), { force: true });
      await unstagePaths(repoDir, [filePath], ceiling);
    } catch (err) {
      logger.error('[rooms] a room file save could not be rolled back; its files are now dirty', {
        repoDir,
        path: filePath,
        err,
      });
    }
  }

  /**
   * Refuse to overwrite something that is not an ordinary file.
   *
   * A directory, a symlink and a submodule each answer the same way a READ of
   * them does, because they are the same three things a room's files can hold
   * that are not a file — and a save that "worked" on any of them would be a
   * save that destroyed something.
   *
   * A DIRECTORY is the case that needs saying out loud: a recursive tree
   * listing holds blobs and gitlinks and no directories at all, so a path that
   * names a folder is simply absent from it — and without this the save would
   * reach `open()` on a directory and fail as a server error rather than as an
   * answer.
   *
   * @param filePath - The path being saved.
   * @param existing - What the tree holds there, or `null`.
   * @param tree - Every blob in `main`'s tree, keyed by path.
   * @throws {RoomError} `ROOM_FILE_NOT_READABLE`.
   */
  private assertOverwritable(
    filePath: string,
    existing: TreeEntry | null,
    tree: Map<string, TreeEntry>
  ): void {
    if (!existing) {
      const asDirectory = `${filePath}/`;
      const lowered = filePath.toLowerCase();
      for (const known of tree.keys()) {
        if (known.startsWith(asDirectory)) {
          throw new RoomError('ROOM_FILE_NOT_READABLE', `\`${filePath}\` is a folder, not a file.`);
        }
        // **A name that differs only in capitals is a collision on this
        // filesystem, not a new file.** macOS and Windows open `room.md` and
        // `ROOM.md` as one file while git records them as two: the write would
        // land on the OTHER file's bytes, the commit would record only the name
        // that was asked for, and the room's own copy would be left dirty —
        // which stops every merge in the room until somebody works out why.
        // Refused with the name that is really there, so the person can open it.
        if (known.toLowerCase() === lowered) {
          throw new RoomError(
            'ROOM_FILE_NOT_READABLE',
            `This room already has \`${known}\`, and a name that differs only in capital letters is the same file on some computers. Save that one instead.`
          );
        }
      }
      return;
    }
    if (existing.mode === SYMLINK_MODE) {
      throw new RoomError(
        'ROOM_FILE_NOT_READABLE',
        `\`${filePath}\` is a link, not a file. DorkOS does not write through links out of a room.`
      );
    }
    if (existing.mode === GITLINK_MODE) {
      throw new RoomError(
        'ROOM_FILE_NOT_READABLE',
        `\`${filePath}\` is another repository inside this one, not a file.`
      );
    }
  }

  /**
   * Refuse a save into a folder the room does not have.
   *
   * **A save never creates a directory** (see the module doc), so the folder
   * above the file has to be one the tree already holds. Asked of the TREE
   * rather than of the disk: the disk is where the answer would be a race, and
   * a clean checkout of a commit holds exactly the directories that commit has.
   *
   * A path with a directory that is really a FILE in the tree (`notes.md/x`)
   * fails the same way, which is the honest answer — the folder is not there.
   *
   * @param filePath - The path being saved.
   * @param tree - Every blob in `main`'s tree, keyed by path.
   * @throws {RoomError} `ROOM_FILE_NOT_FOUND`.
   */
  private assertParentExists(filePath: string, tree: Map<string, TreeEntry>): void {
    const cut = filePath.lastIndexOf('/');
    if (cut === -1) return;
    const parent = filePath.slice(0, cut);
    const prefix = `${parent}/`;
    for (const known of tree.keys()) {
      if (known.startsWith(prefix)) return;
    }
    throw new RoomError(
      'ROOM_FILE_NOT_FOUND',
      `There is no \`${parent}\` folder in this room’s files. Saving does not make new folders — ask an agent working in the room to add one.`
    );
  }

  /**
   * The optimistic lock: did THIS path change since the editor read it?
   *
   * Four answers, and only the last one is a conflict:
   *
   * - The editor read the same commit `main` is at — nothing can have changed.
   * - The editor read a commit this repository does not have — a conflict, and
   *   the honest one: something is out of step and overwriting blind is not the
   *   fix. (A well-formed sha from another repo, or a room whose files were
   *   deleted and given again.)
   * - The blob and mode at the path are identical in both commits — the room
   *   moved on, but not here. The save goes in.
   * - They differ — including "created since", and "deleted since" — and the
   *   caller is told what `main` holds now.
   *
   * @param roomId - The room, for reading who last touched the file.
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   * @param filePath - The path being saved.
   * @param head - The commit `main` points at, or `null`.
   * @param baseCommit - What the editor read, or `null`.
   * @param existing - The tree entry at `head`, or `null`.
   * @returns The conflict, or `null` when the save may proceed.
   */
  private async checkLock(
    roomId: string,
    repoDir: string,
    ceiling: string,
    filePath: string,
    head: string | null,
    baseCommit: string | null,
    existing: TreeEntry | null
  ): Promise<RoomFileConflict | null> {
    if (baseCommit === head) return null;
    // A base commit against a repo with none is not a race anybody can resolve
    // by overwriting: the room's files are not where the editor left them.
    if (head === null) {
      return { path: filePath, commit: '', lastCommit: null };
    }

    const conflict = async (): Promise<RoomFileConflict> => ({
      path: filePath,
      commit: head,
      lastCommit: existing ? await this.lastCommitOf(roomId, filePath) : null,
    });

    if (baseCommit === null) {
      // The editor thought it was creating the first version of this file. If
      // the room now holds one, somebody got there first.
      return existing ? conflict() : null;
    }

    let before: TreeEntry | null;
    try {
      before = (await listTree(repoDir, baseCommit, ceiling)).get(filePath) ?? null;
    } catch (err) {
      if (err instanceof GitUnavailableError) throw err;
      logger.warn('[rooms] a room file save named a commit this room does not have', {
        repoDir,
        baseCommit,
        err,
      });
      return conflict();
    }

    if (before?.sha === existing?.sha && before?.mode === existing?.mode) return null;
    return conflict();
  }

  /**
   * Refuse contents that would stop being readable once they were saved.
   *
   * The repo total is measured the way the merge validation measures it — on
   * the tree the save WOULD leave, not on how much it adds — so the path's own
   * current bytes are replaced rather than counted twice.
   *
   * @param filePath - The path being saved.
   * @param size - How many bytes the new contents are.
   * @param tree - Every blob in `main`'s tree.
   * @param caps - The room's frozen ceilings.
   * @throws {RoomError} `FILE_TOO_LARGE` or `REPO_CAP_EXCEEDED`.
   */
  private assertFits(
    filePath: string,
    size: number,
    tree: Map<string, TreeEntry>,
    caps: RoomRepoCaps
  ): void {
    if (size > caps.maxFileBytes) {
      throw new RoomError(
        'FILE_TOO_LARGE',
        `\`${filePath}\` would be ${describeBytes(size)}, and this room’s limit for one file is ${describeBytes(caps.maxFileBytes)}.`
      );
    }
    let total = size;
    for (const entry of tree.values()) {
      if (entry.path !== filePath) total += entry.size;
    }
    if (total > caps.maxRepoBytes) {
      throw new RoomError(
        'REPO_CAP_EXCEEDED',
        `This would take the room’s files to ${describeBytes(total)}, past its ${describeBytes(caps.maxRepoBytes)} limit. Remove what is no longer needed, or attach large files to a message instead.`
      );
    }
  }

  /**
   * The caps this repo was created under.
   *
   * From the sidecar rather than from config, for the reason
   * `room-merge-service.ts` writes down: a room's contents were legal when they
   * were written, and lowering a setting today must not make yesterday's files
   * retroactively illegal.
   *
   * @param roomId - The room.
   * @throws {RoomError} `ROOM_HAS_NO_REPO` when the sidecar has gone.
   */
  private async requireCaps(roomId: string): Promise<RoomRepoCaps> {
    const sidecar = await this.deps.store.readSidecar(roomId);
    if (!sidecar) {
      throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
    }
    return sidecar.caps;
  }

  /**
   * The commit `main` points at, or `null` when the repo has no commits.
   *
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   */
  private async resolveMain(repoDir: string, ceiling: string): Promise<string | null> {
    try {
      return await revParse(repoDir, 'main', ceiling);
    } catch (err) {
      if (err instanceof GitUnavailableError) throw err;
      return null;
    }
  }

  /**
   * Who last touched a path, in the shape a read answers it.
   *
   * Through the read service rather than a second history walk, so the save's
   * answer and the explorer's row can never describe the same file differently.
   *
   * @param roomId - The room.
   * @param filePath - The path.
   * @returns The commit, or `null` when it cannot be attributed.
   */
  private async lastCommitOf(roomId: string, filePath: string): Promise<RoomFileCommit | null> {
    try {
      return await this.deps.files.lastCommitFor(roomId, filePath);
    } catch (err) {
      logger.warn('[rooms] a saved room file could not be read back for its provenance', {
        roomId,
        path: filePath,
        err,
      });
      return null;
    }
  }

  /**
   * Turn "this machine has no git" into the room domain's own refusal — the
   * same sentence every other room-repo surface gives.
   *
   * @param work - The git-touching body.
   * @returns Whatever `work` answers.
   */
  private async translatingGitAbsence<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
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
}

/**
 * The commit subject one save carries.
 *
 * `Edit ROOM.md` rather than the spec's illustrative "Dorian edited ROOM.md":
 * WHO is the commit's author field, which is where `git log`, the file
 * explorer's provenance column and every other reader already look for it, and
 * repeating it in the subject would show the name twice in every row. What is
 * left is the thing a subject is for — what happened to which file.
 *
 * @param filePath - The file that was saved.
 * @param existed - Whether the room already had it.
 */
function commitSubject(filePath: string, existed: boolean): string {
  return `${existed ? 'Edit' : 'Add'} ${filePath}`;
}

/**
 * Refuse a path that names the repository's own git directory.
 *
 * Runs AFTER {@link normalizeRoomFilePath}, which has already refused `..`, an
 * absolute path, a backslash and a control character — so what is left to check
 * is what the path NAMES rather than where it could climb to. Every segment is
 * tested lower-cased against {@link GIT_DIR_SPELLINGS}: a case-insensitive
 * filesystem opens `.GIT/config` as `.git/config`, and in the integration tree
 * that file is the common directory every one of the room's worktrees shares.
 *
 * A read does not need this and does not do it — it answers out of a commit,
 * and a commit cannot contain `.git`. A write lands on a real filesystem, where
 * it is a real directory.
 *
 * @param filePath - A normalised repo-relative path.
 * @throws {RoomError} `ROOM_FILE_PATH_INVALID`.
 */
function assertWritablePath(filePath: string): void {
  for (const segment of filePath.split('/')) {
    const lowered = segment.toLowerCase();
    if (GIT_DIR_SPELLINGS.includes(lowered)) {
      throw new RoomError(
        'ROOM_FILE_PATH_INVALID',
        'That path is not one this room can have: it names the room’s own git directory.'
      );
    }
  }
}

/**
 * Refuse a path this room's own `.gitignore` excludes.
 *
 * A save is a commit, and `git add` refuses an ignored path outright — so
 * without this the request would fail deep inside git and answer a server
 * error, having written a file it then has to take back. The probe is one cheap
 * command and turns that into a sentence.
 *
 * The ignore rules are member-written, so this is not a security boundary; it is
 * an honest answer about what the room keeps.
 *
 * @param repoDir - The room's main checkout.
 * @param ceilingDir - The room home directory git's search may not climb past.
 * @param filePath - The normalised repo-relative path.
 * @throws {RoomError} `ROOM_FILE_NOT_READABLE`.
 */
async function assertNotIgnored(
  repoDir: string,
  ceilingDir: string,
  filePath: string
): Promise<void> {
  if (!(await isIgnored(repoDir, filePath, ceilingDir))) return;
  throw new RoomError(
    'ROOM_FILE_NOT_READABLE',
    `This room’s files are set to ignore \`${filePath}\`, so saving it would not keep it. Change the room’s \`.gitignore\` first, or save somewhere else.`
  );
}

/**
 * Refuse contents that would not survive being read back.
 *
 * A `NUL` anywhere makes the file binary by git's own test, and the read path
 * answers a binary file as `binary` rather than as text — so committing one
 * would hand somebody a file they saved and can no longer open. Refusing is the
 * honest half of the same rule.
 *
 * @param filePath - The path being saved.
 * @param bytes - The contents.
 * @throws {RoomError} `ROOM_FILE_NOT_TEXT`.
 */
function assertText(filePath: string, bytes: Buffer): void {
  if (!bytes.includes(0)) return;
  throw new RoomError(
    'ROOM_FILE_NOT_TEXT',
    `\`${filePath}\` would not be a text file any more, and DorkOS only saves text here. Share a file like that as an attachment instead.`
  );
}

/**
 * Refuse a save whose path passes through, or lands on, a symlink on disk.
 *
 * The tree already says what git knows about; this is about what git does NOT
 * know about. An untracked symlink hidden from `git status` by a member-written
 * `.gitignore` is invisible to every check above, and writing through it puts
 * the person's file wherever it points — outside the room, on the machine
 * running DorkOS.
 *
 * Each existing ancestor is `lstat`ed, deepest last, and the target itself with
 * it. Nothing is resolved: the question is "is this component a link", which a
 * `lstat` answers exactly, rather than "where does this path end up", which is
 * the question that has to be asked again after every change to the filesystem.
 *
 * @param repoDir - The room's main checkout.
 * @param filePath - The normalised repo-relative path.
 * @throws {RoomError} `ROOM_FILE_NOT_READABLE`.
 */
async function assertNoLinkOnDisk(repoDir: string, filePath: string): Promise<void> {
  const segments = filePath.split('/');
  let at = repoDir;
  for (const [index, segment] of segments.entries()) {
    at = path.join(at, segment);
    let stat;
    try {
      stat = await fs.lstat(at);
    } catch {
      // Not there yet: the file being created, or a directory the tree checks
      // have already refused. Nothing to follow.
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new RoomError(
        'ROOM_FILE_NOT_READABLE',
        `\`${segments.slice(0, index + 1).join('/')}\` is a link, and DorkOS does not write through links out of a room.`
      );
    }
  }
}

/**
 * A byte count as a person reads it — the same coarse shape the merge refusals
 * use, so two ceilings on the same act are described the same way.
 *
 * @param bytes - The count.
 */
function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
