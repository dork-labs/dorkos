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
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { types as utilTypes } from 'node:util';
import { eq } from 'drizzle-orm';
import { roomRepos, rooms, type Db } from '@dorkos/db';
import { RoomRepoSidecarSchema, type RoomRepoSidecar } from '@dorkos/shared/room-repo';
import { logger } from '../../../lib/logger.js';
import {
  readOriginalRoomRepoStoreOperation,
  readOriginalRoomRepoCleanupOperation,
} from './room-repo-service.js';
import { readOriginalRoomRepoMaintenanceOperation } from './room-repo-reconciler.js';
import { readOriginalRoomMergeStoreOperation } from './room-merge-service.js';
import {
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  readInstallationRoomMutationRoots,
  readInstallationRoomStoreRoots,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';

/**
 * The file inside a room's home directory that records its repo.
 *
 * A constant rather than an inline string because the reconciler's directory
 * walk and the store's path builder must name the same file, and a typo in
 * either would look like "no room on this install has a repo".
 */
export const ROOM_REPO_SIDECAR_FILENAME = 'room-repo.json';
/** New internal persistence refusal ceiling; oversize historical files stay untouched. */
const ROOM_REPO_SIDECAR_MAX_BYTES = 64 * 1024;
function requireBoundedRoomRepoScalars(sidecar: RoomRepoSidecar): void {
  // Bound each variable scalar before stringify; the byte check also covers UTF8/JSON escaping.
  for (const value of [sidecar.roomId, sidecar.createdAt, sidecar.createdBy]) {
    if (typeof value !== 'string' || value.length > ROOM_REPO_SIDECAR_MAX_BYTES)
      throw new Error('Room sidecar exceeds its persistence ceiling.');
  }
}
function captureRoomRepoPersistenceMetadata(input: RoomRepoSidecar): RoomRepoSidecar {
  const capture = (value: object, allowed: readonly string[]): Record<string, unknown> => {
    if (
      utilTypes.isProxy(value) ||
      !value ||
      typeof value !== 'object' ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    )
      throw new Error('Room sidecar persistence requires plain metadata.');
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.includes(key))
        throw new Error('Room sidecar contains unsupported persistence fields.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        throw new Error('Room sidecar persistence requires plain data fields.');
      result[key] = descriptor.value;
    }
    return result;
  };
  const result = capture(input, [
    'roomId',
    'mode',
    'createdAt',
    'createdBy',
    'defaultBranch',
    'caps',
    'lastMergeSeq',
  ]);
  if (result.caps !== undefined)
    result.caps = Object.freeze(
      capture(result.caps as object, ['maxFileBytes', 'maxRepoBytes', 'maxRoomMdBytes'])
    );
  const sidecar = Object.freeze(result) as unknown as RoomRepoSidecar;
  requireBoundedRoomRepoScalars(sidecar);
  return sidecar;
}
function serializeBoundedRoomRepoSidecar(sidecar: RoomRepoSidecar): Buffer {
  requireBoundedRoomRepoScalars(sidecar);
  if (
    (Object.getPrototypeOf(sidecar) !== Object.prototype &&
      Object.getPrototypeOf(sidecar) !== null) ||
    Object.prototype.hasOwnProperty.call(sidecar, 'toJSON')
  )
    throw new Error('Room sidecar persistence requires plain metadata.');
  // Legacy public fixture input must also have a finite known shape; refuse extra data rather than discard it.
  for (const key in sidecar) {
    if (
      !Object.prototype.hasOwnProperty.call(sidecar, key) ||
      ![
        'roomId',
        'mode',
        'createdAt',
        'createdBy',
        'defaultBranch',
        'caps',
        'lastMergeSeq',
      ].includes(key)
    )
      throw new Error('Room sidecar contains unsupported persistence fields.');
  }
  if (sidecar.mode !== 'owned' || sidecar.defaultBranch !== 'main')
    throw new Error('Unsupported Room sidecar binding.');
  if (sidecar.caps !== undefined) {
    if (
      sidecar.caps === null ||
      typeof sidecar.caps !== 'object' ||
      (Object.getPrototypeOf(sidecar.caps) !== Object.prototype &&
        Object.getPrototypeOf(sidecar.caps) !== null) ||
      Object.prototype.hasOwnProperty.call(sidecar.caps, 'toJSON')
    )
      throw new Error('Room sidecar cap persistence requires plain metadata.');
    for (const key in sidecar.caps) {
      if (
        !Object.prototype.hasOwnProperty.call(sidecar.caps, key) ||
        !['maxFileBytes', 'maxRepoBytes', 'maxRoomMdBytes'].includes(key)
      )
        throw new Error('Room sidecar contains unsupported cap fields.');
    }
    for (const value of [
      sidecar.caps.maxFileBytes,
      sidecar.caps.maxRepoBytes,
      sidecar.caps.maxRoomMdBytes,
    ]) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))
        throw new Error('Invalid Room sidecar numeric cap.');
    }
  }
  if (
    sidecar.lastMergeSeq !== null &&
    (typeof sidecar.lastMergeSeq !== 'number' || !Number.isFinite(sidecar.lastMergeSeq))
  )
    throw new Error('Invalid Room sidecar merge sequence.');
  const bytes = Buffer.from(JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
  if (bytes.byteLength > ROOM_REPO_SIDECAR_MAX_BYTES)
    throw new Error('Room sidecar exceeds its persistence ceiling.');
  return bytes;
}

/**
 * The characters a room id may be made of before it reaches the filesystem.
 *
 * The same allowlist `LocalRoomAttachmentStore` applies to the same segment of
 * the same path, and an allowlist for the same reason: a room id arrives here
 * from a URL path segment, and the only safe way to know a string is not a path
 * is that it cannot contain one.
 */
export const SAFE_ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thrown when a room id could be read as a path. */
export class InvalidRoomIdError extends Error {
  constructor(roomId: string) {
    super(`Invalid room id: ${roomId}`);
    this.name = 'InvalidRoomIdError';
  }
}

/** Map a sidecar onto its derived cache row. */
function toRow(sidecar: RoomRepoSidecar): typeof roomRepos.$inferInsert {
  return {
    roomId: sidecar.roomId,
    mode: sidecar.mode,
    createdAt: sidecar.createdAt,
    lastMergeSeq: sidecar.lastMergeSeq,
  };
}

interface RoomRepoOwner {
  db: Db;
  native: Db['$client'];
  root: string;
  read(roomId: string): typeof roomRepos.$inferSelect | null;
  rows(): readonly Readonly<typeof roomRepos.$inferSelect>[];
  exists(roomId: string): boolean;
  remove(context: InstallationRoomMutationContext, roomId: string): void;
  readSidecar(
    context: InstallationRoomMutationContext,
    roomId: string
  ): Promise<RoomRepoSidecar | null>;
  write(context: InstallationRoomMutationContext, sidecar: RoomRepoSidecar): Promise<void>;
  upsert(context: InstallationRoomMutationContext, sidecar: RoomRepoSidecar): void;
  rollback(context: InstallationRoomMutationContext): Promise<void>;
}
const roomRepoOwners = new WeakMap<object, RoomRepoOwner>();
/** Constructor custody only: this never establishes room or document permission. */
export function requireRoomRepoStoreDatabase(store: unknown, db: Db): undefined {
  const owner = store && typeof store === 'object' ? roomRepoOwners.get(store) : undefined;
  if (!owner || owner.db !== db || owner.native !== db.$client || !owner.native.open)
    throw new Error('Unknown room repository store or native database.');
  if (owner.native.inTransaction)
    throw new Error('Room filesystem ownership cannot await inside SQL.');
  return undefined;
}
/** Fixed constructor-owned row/root reader; public method replacement cannot manufacture data. */
export function readOwnedRoomRepoSource(
  store: RoomRepoStore,
  db: Db,
  roomId: string
): Readonly<{
  root: string;
  home: string;
  repo: string;
  row: Readonly<typeof roomRepos.$inferSelect> | null;
}> {
  requireRoomRepoStoreDatabase(store, db);
  if (!SAFE_ROOM_ID.test(roomId)) throw new InvalidRoomIdError(roomId);
  const owner = roomRepoOwners.get(store)!;
  const row = owner.read(roomId);
  requireRoomRepoStoreDatabase(store, db);
  if (roomRepoOwners.get(store) !== owner) throw new Error('Room repository owner changed.');
  const home = path.join(owner.root, roomId);
  return Object.freeze({
    root: owner.root,
    home,
    repo: path.join(home, 'repo'),
    row: row === null ? null : Object.freeze({ ...row }),
  });
}

/**
 * Fixed synchronous native transaction DATA; this never permits filesystem ownership awaits.
 * @param store - Actual constructor-owned repository store.
 * @param db - The same original native database.
 * @param roomId - Room whose original row/layout is read.
 * @returns Fresh original row and constructor-captured layout DATA.
 */
export function readOwnedRoomRepoTransactionSource(
  store: RoomRepoStore,
  db: Db,
  roomId: string
): ReturnType<typeof readOwnedRoomRepoSource> {
  requireServerNativeDatabaseQueryCustody(db);
  const owner = roomRepoOwners.get(store);
  if (
    !owner ||
    owner.db !== db ||
    owner.native !== db.$client ||
    !owner.native.open ||
    !owner.native.inTransaction
  )
    throw new Error('Original room repository transaction DATA unavailable.');
  if (!SAFE_ROOM_ID.test(roomId)) throw new InvalidRoomIdError(roomId);
  const row = owner.read(roomId);
  requireServerNativeDatabaseQueryCustody(db);
  if (
    roomRepoOwners.get(store) !== owner ||
    owner.native !== db.$client ||
    !owner.native.open ||
    !owner.native.inTransaction
  )
    throw new Error('Original room repository transaction DATA retired.');
  const home = path.join(owner.root, roomId);
  return Object.freeze({
    root: owner.root,
    home,
    repo: path.join(home, 'repo'),
    row: row === null ? null : Object.freeze({ ...row }),
  });
}

function requireOriginalStoreOperation(
  store: RoomRepoStore,
  db: Db,
  context: InstallationRoomMutationContext,
  roomId: string
): void {
  requireRoomRepoStoreDatabase(store, db);
  const operation =
    readOriginalRoomRepoStoreOperation(context, store, db) ??
    readOriginalRoomMergeStoreOperation(context, store, db) ??
    readOriginalRoomRepoMaintenanceOperation(context, store, db);
  if (!operation || operation.roomId !== roomId)
    throw new Error('Room sidecar mutation requires its original active service operation.');
  const source = readOwnedRoomRepoSource(store, db, roomId),
    roots = readInstallationRoomMutationRoots(context);
  if (roots.homePath !== source.home || roots.repoPath !== source.repo)
    throw new Error('Room sidecar mutation belongs to another source.');
  requireInstallationRoomMutationTarget(context, source.home);
}
/** Write a sidecar through the original Room repository store operation. */
export function executeOriginalRoomRepoStoreWrite(
  store: RoomRepoStore,
  db: Db,
  context: InstallationRoomMutationContext,
  sidecar: RoomRepoSidecar
): Promise<void> {
  requireOriginalStoreOperation(store, db, context, sidecar.roomId);
  return roomRepoOwners.get(store)!.write(context, sidecar);
}
/** Read a sidecar through the original Room repository store operation. */
export function executeOriginalRoomRepoStoreRead(
  store: RoomRepoStore,
  db: Db,
  context: InstallationRoomMutationContext,
  roomId: string
): Promise<RoomRepoSidecar | null> {
  requireOriginalStoreOperation(store, db, context, roomId);
  return roomRepoOwners.get(store)!.readSidecar(context, roomId);
}
/** Upsert repository DATA through the original Room store operation. */
export function executeOriginalRoomRepoStoreUpsert(
  store: RoomRepoStore,
  db: Db,
  context: InstallationRoomMutationContext,
  sidecar: RoomRepoSidecar
): void {
  requireOriginalStoreOperation(store, db, context, sidecar.roomId);
  roomRepoOwners.get(store)!.upsert(context, sidecar);
}
/** Retract only this Store's exact acquired publication, under its original admitted cleanup lifetime. */
export function rollbackOriginalRoomRepoStoreWrite(
  store: RoomRepoStore,
  db: Db,
  context: InstallationRoomMutationContext
): Promise<void> {
  requireRoomRepoStoreDatabase(store, db);
  const operation = readOriginalRoomRepoCleanupOperation(context, store, db);
  if (!operation) throw new Error('Room sidecar cleanup lost its original admitted operation.');
  return roomRepoOwners.get(store)!.rollback(context);
}
/** Fixed constructor native inventory for the original accepted maintenance pass, not user permission. */
export function readOriginalRoomRepoInventory(store: RoomRepoStore, db: Db) {
  requireRoomRepoStoreDatabase(store, db);
  const owner = roomRepoOwners.get(store)!;
  const result = Object.freeze({ root: owner.root, rows: owner.rows() });
  requireRoomRepoStoreDatabase(store, db);
  return result;
}
/** Read room existence through the original repository store. */
export function originalRoomRepoRoomExists(store: RoomRepoStore, db: Db, roomId: string): boolean {
  requireRoomRepoStoreDatabase(store, db);
  const result = roomRepoOwners.get(store)!.exists(roomId);
  requireRoomRepoStoreDatabase(store, db);
  return result;
}
/** Remove a cache entry through the original Room repository operation. */
export function executeOriginalRoomRepoCacheRemove(
  store: RoomRepoStore,
  db: Db,
  context: InstallationRoomMutationContext,
  roomId: string
): void {
  requireRoomRepoStoreDatabase(store, db);
  roomRepoOwners.get(store)!.remove(context, roomId);
}

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
    roomRepoOwners.set(this, {
      db,
      native: db.$client,
      root: this.#root,
      read: (roomId) => {
        const row = readRow(roomId) as typeof roomRepos.$inferSelect | undefined;
        if (row === undefined) return null;
        if (
          row.roomId !== roomId ||
          typeof row.mode !== 'string' ||
          typeof row.createdAt !== 'string' ||
          (row.lastMergeSeq !== null &&
            (!Number.isSafeInteger(row.lastMergeSeq) || row.lastMergeSeq < 0))
        )
          throw new Error('Room repository cache row is invalid.');
        return row;
      },
      rows: () => {
        requireRoomRepoStoreDatabase(this, db);
        return Object.freeze(
          (allRows() as (typeof roomRepos.$inferSelect)[]).map((row) => {
            if (
              typeof row.roomId !== 'string' ||
              !SAFE_ROOM_ID.test(row.roomId) ||
              row.mode !== 'owned' ||
              typeof row.createdAt !== 'string' ||
              (row.lastMergeSeq !== null &&
                (!Number.isSafeInteger(row.lastMergeSeq) || row.lastMergeSeq < 0))
            )
              throw new Error('Invalid native Room repo inventory row.');
            return Object.freeze({ ...row });
          })
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
    const row = roomRepoOwners.get(this)!.read(publication.sidecar.roomId);
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
    const captured = captureRoomRepoPersistenceMetadata(input);
    const sidecar = Object.freeze(RoomRepoSidecarSchema.parse(captured));
    const serialized = serializeBoundedRoomRepoSidecar(sidecar);
    const roots = readInstallationRoomStoreRoots(context, this, this.#db),
      dir = roots.home;
    requireOriginalStoreOperation(this, this.#db, context, sidecar.roomId);
    const installation = await fs.lstat(roots.installation);
    if (
      !installation.isDirectory() ||
      installation.isSymbolicLink() ||
      (await fs.realpath(roots.installation)) !== roots.canonicalInstallation
    )
      throw new Error('Room installation root changed.');
    requireOriginalStoreOperation(this, this.#db, context, sidecar.roomId);
    for (const directory of [roots.root, dir]) {
      const parentPath = path.dirname(directory),
        parentBefore = await fs.lstat(parentPath);
      if (
        !parentBefore.isDirectory() ||
        parentBefore.isSymbolicLink() ||
        (await fs.realpath(parentPath)) !==
          path.join(roots.canonicalInstallation, path.relative(roots.installation, parentPath))
      )
        throw new Error('Room sidecar directory parent is not its actual directory.');
      let before: Stats | undefined;
      try {
        before = await fs.lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      if (before && (!before.isDirectory() || before.isSymbolicLink()))
        throw new Error('Room sidecar directory is not its actual directory.');
      if (
        !sameStoreInode(parentBefore, await fs.lstat(parentPath)) ||
        !sameStoreInode(installation, await fs.lstat(roots.installation))
      )
        throw new Error('Room sidecar directory parent replaced before acquisition.');
      requireOriginalStoreOperation(this, this.#db, context, sidecar.roomId);
      if (!before) await fs.mkdir(directory);
      const stat = await fs.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (before && !sameStoreInode(before, stat)) ||
        (await fs.realpath(directory)) !==
          path.join(roots.canonicalInstallation, path.relative(roots.installation, directory)) ||
        !sameStoreInode(parentBefore, await fs.lstat(parentPath)) ||
        !sameStoreInode(installation, await fs.lstat(roots.installation))
      )
        throw new Error('Room sidecar parent is not its actual directory.');
      requireOriginalStoreOperation(this, this.#db, context, sidecar.roomId);
    }
    const parent = await fs.lstat(dir),
      target = path.join(dir, ROOM_REPO_SIDECAR_FILENAME),
      tmp = path.join(dir, `.${randomUUID()}.tmp`);
    const previousRow = roomRepoOwners.get(this)!.read(sidecar.roomId);
    let previousTarget: Stats | undefined;
    try {
      previousTarget = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    if (previousTarget && (!previousTarget.isFile() || previousTarget.isSymbolicLink()))
      throw new Error('Room sidecar destination is not its actual regular file.');
    await checkInstallationRoomMutationTarget(context, target);
    requireOriginalStoreOperation(this, this.#db, context, sidecar.roomId);
    let file: FileHandle | undefined, acquired: Stats | undefined;
    let failed = false,
      cause: unknown;
    // Join this scope to its captured cleanup before returning or reporting failure.
    const drainOriginalCleanup = async () => {
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
      // Acquired cleanup custody only: no new forward permission or pathname inference.
      // Scope lifetime remains held by the original caller until this finally returns.
      if (acquired) {
        try {
          const currentParent = await fs.lstat(dir),
            currentInstallation = await fs.lstat(roots.installation);
          let currentFile: Stats | undefined;
          try {
            currentFile = await fs.lstat(tmp);
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
          }
          if (currentFile) {
            if (
              !sameStoreInode(parent, currentParent) ||
              !sameStoreInode(installation, currentInstallation) ||
              !sameStoreInode(acquired, currentFile)
            )
              throw new Error('Room sidecar cleanup refuses a foreign file/parent.');
            requireRoomRepoStoreDatabase(this, this.#db);
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
        !sameStoreInode(parent, await fs.lstat(dir)) ||
        !sameStoreInode(installation, await fs.lstat(roots.installation))
      )
        throw new Error('Room sidecar parent replaced before acquisition.');
      requireOriginalStoreOperation(this, this.#db, context, sidecar.roomId);
      file = await fs.open(
        tmp,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600
      );
      acquired = await file.stat();
      if (!acquired.isFile()) throw new Error('Room sidecar temporary acquisition is not a file.');
      await checkInstallationRoomMutationTarget(context, tmp);
      await file.writeFile(serialized);
      await checkInstallationRoomMutationTarget(context, tmp);
      await file.sync();
      await checkInstallationRoomMutationTarget(context, tmp);
      if (
        !sameStoreInode(acquired, await file.stat()) ||
        !sameStoreInode(acquired, await fs.lstat(tmp)) ||
        !sameStoreInode(parent, await fs.lstat(dir)) ||
        !sameStoreInode(installation, await fs.lstat(roots.installation))
      )
        throw new Error('Room sidecar publication lost its acquired file/parent.');
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
            !sameStoreInode(previousTarget, currentTarget)))
      )
        throw new Error('Room sidecar destination replaced before publication.');
      // Repeat parent/acquired identity after the awaited destination observation.
      if (
        !sameStoreInode(parent, await fs.lstat(dir)) ||
        !sameStoreInode(installation, await fs.lstat(roots.installation)) ||
        !sameStoreInode(acquired, await file.stat()) ||
        !sameStoreInode(acquired, await fs.lstat(tmp))
      )
        throw new Error('Room sidecar publication lost its acquired file/parent.');
      requireOriginalStoreOperation(this, this.#db, context, sidecar.roomId);
      // These identity checks refuse observed replacement; pathname rename still has an external race.
      await fs.rename(tmp, target);
      // Record only our acquired inode; a later seed refusal may retract this exact publication.
      this.#publications.set(context, {
        sidecar,
        installation: roots.installation,
        installationStat: installation,
        parent: dir,
        parentStat: parent,
        target,
        acquired,
        previousRow,
        newTarget: previousTarget === undefined,
      });
      await checkInstallationRoomMutationTarget(context, target);
      if (
        !sameStoreInode(acquired, await fs.lstat(target)) ||
        !sameStoreInode(parent, await fs.lstat(dir))
      )
        throw new Error('Room sidecar readback lost its acquired publication.');
      this.#upsertOwned(context, sidecar);
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
      await drainOriginalCleanup();
    }
    if (failed) throw cause;
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
