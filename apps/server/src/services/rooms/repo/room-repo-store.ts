/**
 * File-first write-through persistence for room repos (ADR-0043, spec
 * `project-rooms` §3.1).
 *
 * `{dorkHome}/rooms/<roomId>/room-repo.json` is the truth; the `room_repos`
 * table is a derived cache. The sidecar is written BEFORE the row and deleted
 * AFTER it, and that ordering is the opposite of `WorkspaceStore.remove`'s on
 * purpose:
 *
 * - **Create.** A crash between the two leaves a sidecar with no row. The
 *   reconciler rebuilds the row from it, so the repo the operator asked for
 *   exists. The other order would leave a row pointing at a directory that was
 *   never bound.
 * - **Remove.** A crash between the two leaves a sidecar whose row is gone —
 *   the same recoverable state, healed the same way. The other order would
 *   delete the truth first and leave the derived row as the only record of a
 *   binding, which is precisely the thing a file-first store exists to prevent.
 *
 * So in both directions the sidecar is the last word: while it is on disk the
 * room has a repo, and no interrupted write can make the cache say otherwise
 * for longer than one reconcile.
 *
 * The layout this module owns, and nothing above it may construct by hand:
 *
 * ```
 * {dorkHome}/rooms/<roomId>/
 *   room-repo.json       <- the sidecar, OUTSIDE the repo (trust boundary)
 *   attachments/         <- LocalRoomAttachmentStore's, untouched here
 *   repo/                <- the room's main checkout
 *   worktrees/<agentSlug>/
 * ```
 *
 * @module server/services/rooms/repo/room-repo-store
 */
import { randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { roomRepos, rooms, type Db } from '@dorkos/db';
import { RoomRepoSidecarSchema, type RoomRepoSidecar } from '@dorkos/shared/room-repo';
import { logger } from '../../../lib/logger.js';
import { readOriginalRoomRepoCleanupOperation } from './room-repo-service.js';
import { readOriginalRoomRepoMaintenanceOperation } from './room-repo-reconciler.js';
import {
  checkInstallationRoomMutationTarget,
  readInstallationRoomStoreRoots,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';

import {
  ROOM_REPO_SIDECAR_FILENAME,
  ROOM_REPO_SIDECAR_MAX_BYTES,
  SAFE_ROOM_ID,
  InvalidRoomIdError,
  captureRoomRepoPersistenceMetadata,
  serializeBoundedRoomRepoSidecar,
  toRow,
  captureRoomRepoCacheRow,
  captureRoomRepoInventoryRow,
} from './repository-store/room-repo-sidecar-data.js';
export {
  ROOM_REPO_SIDECAR_FILENAME,
  SAFE_ROOM_ID,
  InvalidRoomIdError,
} from './repository-store/room-repo-sidecar-data.js';
import { createIsolatedRoomRepoOwnerCustody } from './repository-store/room-repo-owner-custody.js';

import { publishOriginalRoomRepoSidecar } from './repository-store/room-repo-publish-current.js';
import type { OriginalRoomRepoPublicationView } from './repository-store/room-repo-publication-context.js';

const originalRoomRepoPublicationViews = new WeakMap<object, OriginalRoomRepoPublicationView>();
const originalRoomRepoPublicationGet = WeakMap.prototype.get;
const originalRoomRepoPublicationSet = WeakMap.prototype.set;
const originalRoomRepoPublicationApply = Reflect.apply;
/** Only the original constructor-private key may retrieve its fixed publication view. */
export function readOriginalRoomRepoPublicationView(
  owner: object
): OriginalRoomRepoPublicationView {
  const view = originalRoomRepoPublicationApply(
    originalRoomRepoPublicationGet,
    originalRoomRepoPublicationViews,
    [owner]
  ) as OriginalRoomRepoPublicationView | undefined;
  if (!view) throw new Error('Unknown original Room repository publication owner.');
  return view;
}

const originalRoomRepoCustody = createIsolatedRoomRepoOwnerCustody();
const requireOriginalStoreOperation = originalRoomRepoCustody.requireOriginalStoreOperation;
/** Original constructor-owned Room repository operation. */
export const requireRoomRepoStoreDatabase: (
  ...args: Parameters<typeof originalRoomRepoCustody.requireRoomRepoStoreDatabase>
) => ReturnType<typeof originalRoomRepoCustody.requireRoomRepoStoreDatabase> =
  originalRoomRepoCustody.requireRoomRepoStoreDatabase;
/** Original constructor-owned Room repository operation. */
export const readOwnedRoomRepoSource: (
  ...args: Parameters<typeof originalRoomRepoCustody.readOwnedRoomRepoSource>
) => ReturnType<typeof originalRoomRepoCustody.readOwnedRoomRepoSource> =
  originalRoomRepoCustody.readOwnedRoomRepoSource;
/** Original constructor-owned Room repository operation. */
export const readOwnedRoomRepoTransactionSource: (
  ...args: Parameters<typeof originalRoomRepoCustody.readOwnedRoomRepoTransactionSource>
) => ReturnType<typeof originalRoomRepoCustody.readOwnedRoomRepoTransactionSource> =
  originalRoomRepoCustody.readOwnedRoomRepoTransactionSource;
/** Original constructor-owned Room repository operation. */
export const executeOriginalRoomRepoStoreWrite: (
  ...args: Parameters<typeof originalRoomRepoCustody.executeOriginalRoomRepoStoreWrite>
) => ReturnType<typeof originalRoomRepoCustody.executeOriginalRoomRepoStoreWrite> =
  originalRoomRepoCustody.executeOriginalRoomRepoStoreWrite;
/** Original constructor-owned Room repository operation. */
export const executeOriginalRoomRepoStoreRead: (
  ...args: Parameters<typeof originalRoomRepoCustody.executeOriginalRoomRepoStoreRead>
) => ReturnType<typeof originalRoomRepoCustody.executeOriginalRoomRepoStoreRead> =
  originalRoomRepoCustody.executeOriginalRoomRepoStoreRead;
/** Original constructor-owned Room repository operation. */
export const executeOriginalRoomRepoStoreUpsert: (
  ...args: Parameters<typeof originalRoomRepoCustody.executeOriginalRoomRepoStoreUpsert>
) => ReturnType<typeof originalRoomRepoCustody.executeOriginalRoomRepoStoreUpsert> =
  originalRoomRepoCustody.executeOriginalRoomRepoStoreUpsert;
/** Original constructor-owned Room repository operation. */
export const rollbackOriginalRoomRepoStoreWrite: (
  ...args: Parameters<typeof originalRoomRepoCustody.rollbackOriginalRoomRepoStoreWrite>
) => ReturnType<typeof originalRoomRepoCustody.rollbackOriginalRoomRepoStoreWrite> =
  originalRoomRepoCustody.rollbackOriginalRoomRepoStoreWrite;
/** Original constructor-owned Room repository operation. */
export const readOriginalRoomRepoInventory: (
  ...args: Parameters<typeof originalRoomRepoCustody.readOriginalRoomRepoInventory>
) => ReturnType<typeof originalRoomRepoCustody.readOriginalRoomRepoInventory> =
  originalRoomRepoCustody.readOriginalRoomRepoInventory;
/** Original constructor-owned Room repository operation. */
export const originalRoomRepoRoomExists: (
  ...args: Parameters<typeof originalRoomRepoCustody.originalRoomRepoRoomExists>
) => ReturnType<typeof originalRoomRepoCustody.originalRoomRepoRoomExists> =
  originalRoomRepoCustody.originalRoomRepoRoomExists;
/** Original constructor-owned Room repository operation. */
export const executeOriginalRoomRepoCacheRemove: (
  ...args: Parameters<typeof originalRoomRepoCustody.executeOriginalRoomRepoCacheRemove>
) => ReturnType<typeof originalRoomRepoCustody.executeOriginalRoomRepoCacheRemove> =
  originalRoomRepoCustody.executeOriginalRoomRepoCacheRemove;

function sameStoreInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * File-first store for a room's repo binding.
 *
 * Construct with the DB handle and the resolved DorkOS data directory — never
 * `os.homedir()`, which is banned in `apps/server/src` (Hard Rule 3).
 */
export class RoomRepoStore {
  readonly #publicationKey = Object.freeze({});
  /** `{dorkHome}/rooms` — the same root the attachment store hangs off. */
  readonly #root: string;
  readonly #db: Db;
  readonly #nativeUpsert: (
    sidecar: Pick<RoomRepoSidecar, 'roomId' | 'mode' | 'createdAt' | 'lastMergeSeq'>
  ) => void;
  readonly #nativeRemove: (roomId: string) => void;
  readonly #publications = new WeakMap<
    InstallationRoomMutationContext,
    {
      sidecar: RoomRepoSidecar;
      installation: string;
      installationStat: Stats;
      parent: string;
      parentStat: Stats;
      target: string;
      acquired: Stats;
      previousRow: Readonly<typeof roomRepos.$inferSelect> | null;
      newTarget: boolean;
    }
  >();

  /**
   * Bind the store to one install's database and data directory.
   *
   * @param db - The consolidated DB handle.
   * @param dorkHome - The resolved DorkOS data directory. Required, no fallback.
   */
  constructor(db: Db, dorkHome: string) {
    this.#db = db;
    this.#root = path.join(dorkHome, 'rooms');
    const prepare = db.$client.prepare.bind(db.$client);
    const upsert = prepare(
      'INSERT INTO room_repos (room_id, mode, created_at, last_merge_seq) VALUES (?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET mode = excluded.mode, created_at = excluded.created_at, last_merge_seq = excluded.last_merge_seq'
    );
    const runUpsert = upsert.run.bind(upsert);
    const select = prepare(
      'SELECT room_id AS roomId, mode, created_at AS createdAt, last_merge_seq AS lastMergeSeq FROM room_repos WHERE room_id = ?'
    );
    const readRow = select.get.bind(select);
    const allRowsStatement = prepare(
      'SELECT room_id AS roomId, mode, created_at AS createdAt, last_merge_seq AS lastMergeSeq FROM room_repos'
    );
    const allRows = allRowsStatement.all.bind(allRowsStatement);
    const existsStatement = prepare('SELECT id FROM rooms WHERE id = ? LIMIT 1');
    const existsRow = existsStatement.get.bind(existsStatement);
    const remove = prepare('DELETE FROM room_repos WHERE room_id = ?');
    const removeRow = remove.run.bind(remove);
    this.#nativeRemove = (roomId) => {
      removeRow(roomId);
    };
    this.#nativeUpsert = (sidecar) => {
      runUpsert(sidecar.roomId, sidecar.mode, sidecar.createdAt, sidecar.lastMergeSeq);
    };
    originalRoomRepoCustody.register(this, {
      db,
      native: db.$client,
      root: this.#root,
      read: (roomId) => {
        const row = readRow(roomId) as typeof roomRepos.$inferSelect | undefined;
        return captureRoomRepoCacheRow(row, roomId);
      },
      rows: () => {
        requireRoomRepoStoreDatabase(this, db);
        return Object.freeze(
          (allRows() as (typeof roomRepos.$inferSelect)[]).map(captureRoomRepoInventoryRow)
        );
      },
      exists: (roomId) => {
        requireRoomRepoStoreDatabase(this, db);
        return existsRow(roomId) !== undefined;
      },
      remove: (context, roomId) => this.#removeMaintenanceRow(context, roomId),
      readSidecar: (context, roomId) => this.#readOwned(context, roomId),
      write: (context, sidecar) => this.#writeOwned(context, sidecar),
      upsert: (context, sidecar) => this.#upsertOwned(context, sidecar),
      rollback: (context) => this.#rollbackOwned(context),
    });
    originalRoomRepoPublicationApply(
      originalRoomRepoPublicationSet,
      originalRoomRepoPublicationViews,
      [
        this.#publicationKey,
        Object.freeze({
          store: this,
          db,
          publications: this.#publications,
          readOwner: originalRoomRepoCustody.readOwner,
          requireOriginalStoreOperation,
          sameStoreInode,
          upsertOwned: (context: InstallationRoomMutationContext, sidecar: RoomRepoSidecar) =>
            this.#upsertOwned(context, sidecar),
        }),
      ]
    );
  }

  #removeMaintenanceRow(context: InstallationRoomMutationContext, roomId: string): void {
    const actual = readOriginalRoomRepoMaintenanceOperation(context, this, this.#db);
    if (!actual || actual.roomId !== roomId)
      throw new Error('Room cache removal lacks its original maintenance lifetime.');
    requireOriginalStoreOperation(this, this.#db, context, roomId);
    this.#nativeRemove(roomId);
  }

  async #rollbackOwned(context: InstallationRoomMutationContext): Promise<void> {
    const publication = this.#publications.get(context);
    if (!publication) return; // Existing or merely observed sidecars are never acquired cleanup receipts.
    const requireCleanup = () => {
      requireRoomRepoStoreDatabase(this, this.#db);
      const operation = readOriginalRoomRepoCleanupOperation(context, this, this.#db);
      if (
        !operation ||
        operation.roomId !== publication.sidecar.roomId ||
        this.#publications.get(context) !== publication
      )
        throw new Error('Room sidecar cleanup is foreign or retired.');
    };
    requireCleanup();
    const parent = await fs.lstat(publication.parent),
      installation = await fs.lstat(publication.installation);
    const file = await fs.lstat(publication.target);
    if (
      !sameStoreInode(publication.parentStat, parent) ||
      !sameStoreInode(publication.installationStat, installation) ||
      !file.isFile() ||
      file.isSymbolicLink() ||
      !sameStoreInode(publication.acquired, file)
    )
      throw new Error('Room sidecar cleanup refuses a foreign publication/parent.');
    const row = originalRoomRepoCustody.readOwner(this)!.read(publication.sidecar.roomId);
    if (
      row &&
      (row.mode !== publication.sidecar.mode ||
        row.createdAt !== publication.sidecar.createdAt ||
        row.lastMergeSeq !== publication.sidecar.lastMergeSeq) &&
      (!publication.previousRow ||
        row.mode !== publication.previousRow.mode ||
        row.createdAt !== publication.previousRow.createdAt ||
        row.lastMergeSeq !== publication.previousRow.lastMergeSeq)
    )
      throw new Error('Room sidecar cleanup refuses a changed cache row.');
    requireCleanup();
    // Existing bindings/files are never deleted as though this enable acquired them.
    // A preexisting cache row is left unchanged on a failed pre-upsert, or restored
    // only when its current value is exactly this operation's own publication.
    if (publication.previousRow) {
      if (
        row &&
        row.mode === publication.sidecar.mode &&
        row.createdAt === publication.sidecar.createdAt &&
        row.lastMergeSeq === publication.sidecar.lastMergeSeq
      ) {
        if (publication.previousRow.mode !== 'owned')
          throw new Error('Room sidecar cleanup refuses a foreign cache mode.');
        this.#nativeUpsert({ ...publication.previousRow, mode: publication.previousRow.mode });
      }
    } else if (row) this.#nativeRemove(publication.sidecar.roomId);
    if (!publication.newTarget) {
      this.#publications.delete(context);
      return;
    }
    const currentFile = await fs.lstat(publication.target),
      currentParent = await fs.lstat(publication.parent);
    const currentInstallation = await fs.lstat(publication.installation);
    if (
      !sameStoreInode(publication.acquired, currentFile) ||
      !sameStoreInode(publication.parentStat, currentParent) ||
      !sameStoreInode(publication.installationStat, currentInstallation)
    )
      throw new Error('Room sidecar cleanup refuses observed replacement.');
    requireCleanup();
    await fs.unlink(publication.target);
    this.#publications.delete(context);
  }

  async #readOwned(
    context: InstallationRoomMutationContext,
    roomId: string
  ): Promise<RoomRepoSidecar | null> {
    const roots = readInstallationRoomStoreRoots(context, this, this.#db),
      target = path.join(roots.home, ROOM_REPO_SIDECAR_FILENAME);
    requireOriginalStoreOperation(this, this.#db, context, roomId);
    let parent: Stats | undefined, previous: Stats | undefined;
    try {
      parent = await fs.lstat(roots.home);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await checkInstallationRoomMutationTarget(context, target);
    if (!parent) return null;
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (await fs.realpath(roots.home)) !==
        path.join(roots.canonicalInstallation, path.relative(roots.installation, roots.home))
    )
      throw new Error('Room sidecar read parent is not its actual directory.');
    try {
      previous = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await checkInstallationRoomMutationTarget(context, target);
    if (!sameStoreInode(parent, await fs.lstat(roots.home)))
      throw new Error('Room sidecar read parent replaced.');
    requireOriginalStoreOperation(this, this.#db, context, roomId);
    if (!previous) return null;
    if (!previous.isFile() || previous.isSymbolicLink())
      throw new Error('Room sidecar read refuses a non-regular file.');
    let handle: FileHandle | undefined, result: RoomRepoSidecar | undefined;
    let failed = false,
      cause: unknown;
    try {
      requireOriginalStoreOperation(this, this.#db, context, roomId);
      handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const acquired = await handle.stat();
      if (!acquired.isFile() || !sameStoreInode(previous, acquired))
        throw new Error('Room sidecar read lost its acquired file.');
      await checkInstallationRoomMutationTarget(context, target);
      if (
        !Number.isSafeInteger(acquired.size) ||
        acquired.size < 0 ||
        acquired.size > ROOM_REPO_SIDECAR_MAX_BYTES
      )
        throw new Error('Room sidecar exceeds its persistence ceiling.');
      const chunks: Buffer[] = [];
      let position = 0;
      while (true) {
        requireOriginalStoreOperation(this, this.#db, context, roomId);
        const chunk = Buffer.alloc(Math.min(4096, ROOM_REPO_SIDECAR_MAX_BYTES + 1 - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
        await checkInstallationRoomMutationTarget(context, target);
        requireOriginalStoreOperation(this, this.#db, context, roomId);
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > ROOM_REPO_SIDECAR_MAX_BYTES)
          throw new Error('Room sidecar grew beyond its persistence ceiling.');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const bytes = Buffer.concat(chunks, position);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes))
        throw new Error('Room sidecar is not valid UTF8.');
      await checkInstallationRoomMutationTarget(context, target);
      const finalAcquired = await handle.stat();
      await checkInstallationRoomMutationTarget(context, target);
      const finalTarget = await fs.lstat(target);
      await checkInstallationRoomMutationTarget(context, target);
      const finalParent = await fs.lstat(roots.home);
      await checkInstallationRoomMutationTarget(context, target);
      for (const observed of [finalAcquired, finalTarget]) {
        if (
          !observed.isFile() ||
          observed.isSymbolicLink() ||
          !sameStoreInode(acquired, observed) ||
          !Number.isSafeInteger(observed.size) ||
          observed.size < 0 ||
          observed.size > ROOM_REPO_SIDECAR_MAX_BYTES ||
          observed.size !== acquired.size ||
          observed.mtimeMs !== acquired.mtimeMs ||
          observed.ctimeMs !== acquired.ctimeMs
        )
          throw new Error('Room sidecar read changed its acquired file.');
      }
      if (!sameStoreInode(parent, finalParent))
        throw new Error('Room sidecar read lost its acquired parent.');
      // Preserve the original full schema and refuse corrupt persisted data; never normalize it.
      result = RoomRepoSidecarSchema.parse(JSON.parse(text));
      if (result.roomId !== roomId) throw new Error('Room sidecar belongs to another room.');
      requireOriginalStoreOperation(this, this.#db, context, roomId);
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
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
    }
    if (failed) throw cause;
    return result!;
  }

  #upsertOwned(context: InstallationRoomMutationContext, sidecar: RoomRepoSidecar): void {
    const parsed = RoomRepoSidecarSchema.parse(sidecar);
    requireOriginalStoreOperation(this, this.#db, context, parsed.roomId);
    this.#nativeUpsert(parsed);
  }

  async #writeOwned(
    context: InstallationRoomMutationContext,
    input: RoomRepoSidecar
  ): Promise<void> {
    return publishOriginalRoomRepoSidecar(this.#publicationKey, context, input);
  }

  /**
   * A room's home directory — the parent of its sidecar, its repo and its
   * worktrees.
   *
   * @param roomId - The room.
   * @throws {InvalidRoomIdError} When the id could be read as a path.
   */
  homeDir(roomId: string): string {
    if (!SAFE_ROOM_ID.test(roomId)) throw new InvalidRoomIdError(roomId);
    return path.join(this.#root, roomId);
  }

  /**
   * Where a room's `room-repo.json` lives. Outside `repo/`, so the repo can
   * never rewrite its own grant.
   *
   * @param roomId - The room.
   */
  sidecarPath(roomId: string): string {
    return path.join(this.homeDir(roomId), ROOM_REPO_SIDECAR_FILENAME);
  }

  /**
   * Where a room's main checkout lives — the integration tree.
   *
   * @param roomId - The room.
   */
  repoPath(roomId: string): string {
    return path.join(this.homeDir(roomId), 'repo');
  }

  /**
   * Where a room's standing per-agent worktrees live.
   *
   * @param roomId - The room.
   */
  worktreesPath(roomId: string): string {
    return path.join(this.homeDir(roomId), 'worktrees');
  }

  /**
   * Persist the sidecar atomically, THEN upsert the cache row.
   *
   * Temp file plus rename, so a reader never sees half a sidecar and an
   * interrupted write leaves the previous one standing.
   *
   * @param sidecar - The binding to record.
   */
  async write(input: RoomRepoSidecar): Promise<void> {
    const sidecar = captureRoomRepoPersistenceMetadata(input);
    const serialized = serializeBoundedRoomRepoSidecar(sidecar);
    const dir = this.homeDir(sidecar.roomId);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${randomUUID()}.tmp`);
    await fs.writeFile(tmp, serialized);
    await fs.rename(tmp, this.sidecarPath(sidecar.roomId));
    this.upsertRow(sidecar);
  }

  /**
   * Upsert only the derived row — the reconciler's half of {@link write}.
   *
   * @param sidecar - The binding the row mirrors.
   */
  upsertRow(sidecar: RoomRepoSidecar): void {
    this.#db
      .insert(roomRepos)
      .values(toRow(sidecar))
      .onConflictDoUpdate({ target: roomRepos.roomId, set: toRow(sidecar) })
      .run();
  }

  /**
   * Drop the cache row, THEN delete the sidecar — see the module doc for why
   * this order and not the workspace store's.
   *
   * Idempotent in both halves: removing a binding that is already gone is not
   * an error, which is what makes it safe for a delete path to call
   * unconditionally.
   *
   * @param roomId - The room whose binding goes away.
   */
  async remove(roomId: string): Promise<void> {
    this.removeRow(roomId);
    await fs.rm(this.sidecarPath(roomId), { force: true });
  }

  /**
   * Drop only the cache row — reconciler use, when a sidecar has vanished.
   *
   * @param roomId - The room.
   */
  removeRow(roomId: string): void {
    this.#db.delete(roomRepos).where(eq(roomRepos.roomId, roomId)).run();
  }

  /**
   * The binding as the CACHE has it, or `null`.
   *
   * A row rather than the file, because this is what a request path reads and a
   * request path should not touch the disk to answer "does this room have a
   * repo". The row is rebuilt from the file every five minutes and written
   * through on every mutation, so the two disagree only inside an interrupted
   * write.
   *
   * @param roomId - The room.
   */
  getRow(roomId: string): typeof roomRepos.$inferSelect | null {
    return this.#db.select().from(roomRepos).where(eq(roomRepos.roomId, roomId)).get() ?? null;
  }

  /** Every cached binding on this install. */
  listRows(): (typeof roomRepos.$inferSelect)[] {
    return this.#db.select().from(roomRepos).all();
  }

  /**
   * Read a room's sidecar off disk — the source of truth.
   *
   * **`null` means "this room has no binding", and nothing else.** Two causes
   * qualify: the file is not there (`ENOENT`), and the file is not a sidecar
   * this build understands — which includes a `'linked'` binding a future build
   * wrote, since the schema refuses that by name and a reconciler that threw on
   * one would stop rebuilding every OTHER room's row on the install.
   *
   * **Every other error is raised.** This used to swallow all of them, and the
   * consequence was not a slow read: `null` is what the reconciler reads as "no
   * sidecar, retire the row", so one pass under file-descriptor pressure
   * (`EMFILE`), or against a directory the server had lost permission to
   * (`EACCES`), would have deleted the cache row of every room on the install.
   * A transient failure must not be spelled the same way as an answer.
   *
   * @param roomId - The room.
   * @returns The parsed sidecar, or `null` when the room has no binding.
   * @throws When the sidecar exists but could not be read.
   */
  async readSidecar(roomId: string): Promise<RoomRepoSidecar | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.sidecarPath(roomId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      logger.error('[rooms] could not read a room-repo sidecar', {
        roomId,
        path: this.sidecarPath(roomId),
        err,
      });
      throw err;
    }
    // Past this line the file exists and was read: a failure is about its
    // CONTENT, which is a real answer about the binding rather than a fault.
    try {
      const parsed = RoomRepoSidecarSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      logger.warn('[rooms] a room-repo sidecar is not one this build can use', {
        roomId,
        reason: parsed.error.issues[0]?.message,
      });
      return null;
    } catch (err) {
      logger.warn('[rooms] a room-repo sidecar is not valid JSON', { roomId, err });
      return null;
    }
  }

  /**
   * Every room id that has a home directory on disk, whether or not it holds a
   * sidecar or a row.
   *
   * The reconciler's starting point: the truth is what is on disk, so the sweep
   * walks the disk rather than the table it is rebuilding.
   *
   * An empty list means no room has ever had a home — `ENOENT` on the root,
   * which is every install until the first repo is enabled. Any other failure
   * is raised, for the same reason {@link RoomRepoStore.readSidecar} raises:
   * the reconciler reads "no homes on disk" as "retire every row", so a
   * permission or descriptor failure spelled as an empty list would empty the
   * cache table.
   *
   * @returns Room ids, or an empty list when no room has ever had a home.
   * @throws When the rooms root exists but could not be listed.
   */
  async listHomeDirs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.#root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && SAFE_ROOM_ID.test(e.name)).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      logger.error('[rooms] could not list the room homes', { root: this.#root, err });
      throw err;
    }
  }

  /**
   * Delete leftover `.{uuid}.tmp` sidecar drafts in one room's home, older than
   * `maxAgeMs`.
   *
   * {@link RoomRepoStore.write} writes to a temp file and renames it, so a
   * process killed between the two leaves the draft behind forever — small, but
   * unbounded across an install's life, and confusing to anybody who opens the
   * directory. The sweep already reads this directory, so tidying costs one
   * `readdir` it was going to do anyway.
   *
   * Age-gated rather than absolute: a draft that is seconds old may belong to a
   * write happening right now, in this process or another.
   *
   * @param roomId - The room whose home to tidy.
   * @param maxAgeMs - How old a draft must be before it is removed.
   * @returns How many were removed.
   */
  async sweepStaleDrafts(roomId: string, maxAgeMs: number): Promise<number> {
    const dir = this.homeDir(roomId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      // Tidying is never the reason a sweep fails; the caller's real work has
      // its own error handling.
      return 0;
    }
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith('.') || !name.endsWith('.tmp')) continue;
      const target = path.join(dir, name);
      try {
        const stat = await fs.stat(target);
        if (stat.mtimeMs > cutoff) continue;
        await fs.rm(target, { force: true });
        removed += 1;
      } catch {
        // Raced with somebody else's cleanup, or not ours to remove. Either way
        // the next pass asks again.
      }
    }
    return removed;
  }

  /**
   * Whether a room still exists — the question the reconciler must ask before
   * inserting a row, because `room_repos.room_id` is a real foreign key and an
   * orphaned sidecar would otherwise fail the sweep for every room after it.
   *
   * @param roomId - The room.
   */
  roomExists(roomId: string): boolean {
    return (
      this.#db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).get() !== undefined
    );
  }

  /**
   * Delete a room's whole home directory — sidecar, repo, worktrees and all.
   *
   * **`Unguarded` is in the name as a warning.** This is the ONLY thing in the
   * domain that destroys work, and it asks nothing before doing it: the
   * unmerged-work question lives in `RoomRepoService.assertHomeRemovable`, and
   * `RoomRepoService.removeHome` is the guarded pair a caller should reach for.
   * A method called `removeHome` on a store reads like the counterpart of
   * `write`, which is exactly the misreading that would delete an agent's
   * unmerged work. The cache row goes first (via
   * {@link RoomRepoStore.remove}'s ordering rule) so an interrupted delete
   * cannot leave a row pointing at a directory that is half gone.
   *
   * **`attachments/` goes with it**, because it is inside the same home
   * directory — which is right for a hard delete (the files were posted into a
   * room that no longer exists) and is exactly why archiving must never reach
   * this function.
   *
   * @param roomId - The room whose home goes away.
   */
  async removeHomeUnguarded(roomId: string): Promise<void> {
    this.removeRow(roomId);
    await fs.rm(this.homeDir(roomId), { recursive: true, force: true });
  }
}
