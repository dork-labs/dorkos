import path from 'node:path';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import type { Db, roomRepos } from '@dorkos/db';
import type { RoomRepoSidecar } from '@dorkos/shared/room-repo';
import type { RoomRepoStore } from '../room-repo-store.js';
import { SAFE_ROOM_ID, InvalidRoomIdError } from './room-repo-sidecar-data.js';
import {
  readOriginalRoomRepoStoreOperation,
  readOriginalRoomRepoCleanupOperation,
} from '../room-repo-service.js';
import { readOriginalRoomRepoMaintenanceOperation } from '../room-repo-reconciler.js';
import { readOriginalRoomMergeStoreOperation } from '../room-merge-service.js';
import {
  requireInstallationRoomMutationTarget,
  readInstallationRoomMutationRoots,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';

/** Type-only shape of the original constructor-captured Room repository ports; no actual owner or registrar is exported. */
export interface RoomRepoOwner {
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
/** Each invocation owns unrelated maps; only the original module retains its actual constructor registrar. */
export function createIsolatedRoomRepoOwnerCustody() {
  const roomRepoOwners = new WeakMap<object, RoomRepoOwner>();
  /** Constructor custody only: this never establishes room or document permission. */
  function requireRoomRepoStoreDatabase(store: unknown, db: Db): undefined {
    const owner = store && typeof store === 'object' ? roomRepoOwners.get(store) : undefined;
    if (!owner || owner.db !== db || owner.native !== db.$client || !owner.native.open)
      throw new Error('Unknown room repository store or native database.');
    if (owner.native.inTransaction)
      throw new Error('Room filesystem ownership cannot await inside SQL.');
    return undefined;
  }
  /** Fixed constructor-owned row/root reader; public method replacement cannot manufacture data. */
  function readOwnedRoomRepoSource(
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
  function readOwnedRoomRepoTransactionSource(
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
  function executeOriginalRoomRepoStoreWrite(
    store: RoomRepoStore,
    db: Db,
    context: InstallationRoomMutationContext,
    sidecar: RoomRepoSidecar
  ): Promise<void> {
    requireOriginalStoreOperation(store, db, context, sidecar.roomId);
    return roomRepoOwners.get(store)!.write(context, sidecar);
  }
  /** Read a sidecar through the original Room repository store operation. */
  function executeOriginalRoomRepoStoreRead(
    store: RoomRepoStore,
    db: Db,
    context: InstallationRoomMutationContext,
    roomId: string
  ): Promise<RoomRepoSidecar | null> {
    requireOriginalStoreOperation(store, db, context, roomId);
    return roomRepoOwners.get(store)!.readSidecar(context, roomId);
  }
  /** Upsert repository DATA through the original Room store operation. */
  function executeOriginalRoomRepoStoreUpsert(
    store: RoomRepoStore,
    db: Db,
    context: InstallationRoomMutationContext,
    sidecar: RoomRepoSidecar
  ): void {
    requireOriginalStoreOperation(store, db, context, sidecar.roomId);
    roomRepoOwners.get(store)!.upsert(context, sidecar);
  }
  /** Retract only this Store's exact acquired publication, under its original admitted cleanup lifetime. */
  function rollbackOriginalRoomRepoStoreWrite(
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
  function readOriginalRoomRepoInventory(store: RoomRepoStore, db: Db) {
    requireRoomRepoStoreDatabase(store, db);
    const owner = roomRepoOwners.get(store)!;
    const result = Object.freeze({ root: owner.root, rows: owner.rows() });
    requireRoomRepoStoreDatabase(store, db);
    return result;
  }
  /** Read room existence through the original repository store. */
  function originalRoomRepoRoomExists(store: RoomRepoStore, db: Db, roomId: string): boolean {
    requireRoomRepoStoreDatabase(store, db);
    const result = roomRepoOwners.get(store)!.exists(roomId);
    requireRoomRepoStoreDatabase(store, db);
    return result;
  }
  /** Remove a cache entry through the original Room repository operation. */
  function executeOriginalRoomRepoCacheRemove(
    store: RoomRepoStore,
    db: Db,
    context: InstallationRoomMutationContext,
    roomId: string
  ): void {
    requireRoomRepoStoreDatabase(store, db);
    roomRepoOwners.get(store)!.remove(context, roomId);
  }

  return Object.freeze({
    register: (store: object, owner: RoomRepoOwner) => roomRepoOwners.set(store, owner),
    readOwner: (store: object) => roomRepoOwners.get(store),
    requireOriginalStoreOperation,
    requireRoomRepoStoreDatabase,
    readOwnedRoomRepoSource,
    readOwnedRoomRepoTransactionSource,
    executeOriginalRoomRepoStoreWrite,
    executeOriginalRoomRepoStoreRead,
    executeOriginalRoomRepoStoreUpsert,
    rollbackOriginalRoomRepoStoreWrite,
    readOriginalRoomRepoInventory,
    originalRoomRepoRoomExists,
    executeOriginalRoomRepoCacheRemove,
  });
}
