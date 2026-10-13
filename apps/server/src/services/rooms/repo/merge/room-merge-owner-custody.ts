/** Per-factory unrelated Room merge construction and original operation custody. */
import type { RoomMergeService } from '../room-merge-service.js';
import type { RoomRepoStore } from '../room-repo-store.js';
import type { RoomMergeResult } from '@dorkos/shared/room-repo';
import type { Db } from '@dorkos/db';
import type { RoomStore } from '../../room-store.js';
import { requireRoomServiceFileWriteOwner, type RoomService } from '../../room-service.js';
import type { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import {
  requireInstallationFileWritesOwner,
  type InstallationFileWrites,
} from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  readInstallationRoomMutationRoots,
  requireInstallationRoomMutationTarget,
  type InstallationRoomWrites,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { captureDocHttpRoomRepoCaller } from '../../../canvas/doc-channel/http-composition.js';
import { type CapabilityHandlerContext } from '../../../core/capabilities/registry.js';
import {
  requireNativePrincipalDatabase,
  type ConnectorRuntimePrincipalService,
} from '../../../connectors/principal/runtime-principal-service.js';
import { DocChannelNotFoundError } from '../../../canvas/doc-channel/authorization.js';

/** Type-only original owning construction shape; no actual construction is exported. */
export interface RoomMergeOwningConstruction {
  readonly owner: InstallationFileWrites;
  readonly writer: InstallationRoomWrites;
  readonly db: Db;
  readonly channels: DocChannelStore;
  readonly rooms: RoomService;
  readonly roomStore: RoomStore;
  readonly nativePrincipals?: ConnectorRuntimePrincipalService;
}
/** Type-only original private native operation shape; no actual operation is exported. */
export interface NativeMergeOperation {
  readonly service: RoomMergeService;
  readonly invocation: object;
  readonly authorId: string;
  readonly roomId: string;
  active: boolean;
}
/** External invocations own unrelated maps; only the original service module retains its actual registrars. */
export function createIsolatedRoomMergeOwnerCustody() {
  const nativeMergeOperations = new WeakMap<object, NativeMergeOperation>();
  const originalMergeServices = new WeakMap<
    RoomMergeService,
    {
      readonly owning: RoomMergeOwningConstruction;
      preflight(): void;
      http(handle: object, input: { summary: string; worktree?: string }): Promise<RoomMergeResult>;
      native(
        context: CapabilityHandlerContext,
        input: { roomId: string; summary: string }
      ): Promise<RoomMergeResult>;
      current(operation: NativeMergeOperation): undefined;
    }
  >();
  /** Require the Room merge service's exact original owner dependencies. */
  function requireRoomMergeServiceOwner(
    service: RoomMergeService,
    owner: InstallationFileWrites,
    db: Db,
    rooms: RoomService
  ): undefined {
    const binding = originalMergeServices.get(service);
    if (
      !binding ||
      binding.owning.owner !== owner ||
      binding.owning.db !== db ||
      binding.owning.rooms !== rooms
    )
      throw new DocChannelNotFoundError();
    requireInstallationFileWritesOwner(owner, db, binding.owning.channels);
    requireRoomServiceFileWriteOwner(rooms, db, binding.owning.roomStore);
    if (binding.owning.nativePrincipals)
      requireNativePrincipalDatabase(binding.owning.nativePrincipals, db);
    if (!db.$client.open || db.$client.inTransaction) throw new DocChannelNotFoundError();
    return undefined;
  }
  /** Require the original runtime registry used by Room merge construction. */
  function requireRoomMergeRegistryConstruction(
    service: RoomMergeService,
    nativePrincipals: ConnectorRuntimePrincipalService,
    db: Db
  ): undefined {
    const binding = originalMergeServices.get(service);
    if (
      !binding ||
      !nativePrincipals ||
      binding.owning.nativePrincipals !== nativePrincipals ||
      binding.owning.db !== db
    )
      throw new DocChannelNotFoundError();
    return requireRoomMergeServiceOwner(service, binding.owning.owner, db, binding.owning.rooms);
  }
  /** Execute a merge through the original Room HTTP caller. */
  function executeRoomHttpMerge(
    service: RoomMergeService,
    handle: object,
    input: { summary: string; worktree?: string }
  ): Promise<RoomMergeResult> {
    const binding = originalMergeServices.get(service);
    if (!binding) return Promise.reject(new DocChannelNotFoundError());
    requireRoomMergeServiceOwner(
      service,
      binding.owning.owner,
      binding.owning.db,
      binding.owning.rooms
    );
    return binding.http(handle, input);
  }
  /** Execute a merge through the original native Room operation. */
  function executeRoomNativeMerge(
    service: RoomMergeService,
    context: CapabilityHandlerContext,
    input: { roomId: string; summary: string }
  ): Promise<RoomMergeResult> {
    const binding = originalMergeServices.get(service);
    if (!binding) return Promise.reject(new DocChannelNotFoundError());
    if (!binding.owning.nativePrincipals) return Promise.reject(new DocChannelNotFoundError());
    requireRoomMergeRegistryConstruction(
      service,
      binding.owning.nativePrincipals,
      binding.owning.db
    );
    return binding.native(context, input);
  }
  /** Fixed private operation recognition, never a caller-supplied currentness function. */
  function requireOriginalRoomNativeMergeCurrent(
    service: RoomMergeService,
    token: object,
    roomId: string
  ): undefined {
    const operation = nativeMergeOperations.get(token),
      binding = originalMergeServices.get(service);
    if (
      !operation?.active ||
      !binding ||
      operation.service !== service ||
      operation.roomId !== roomId
    )
      throw new DocChannelNotFoundError();
    binding.current(operation);
    if (!operation.active || nativeMergeOperations.get(token) !== operation)
      throw new DocChannelNotFoundError();
    return undefined;
  }

  const originalMergeStoreOperations = new WeakMap<
    InstallationRoomMutationContext,
    {
      service: RoomMergeService;
      owning: RoomMergeOwningConstruction;
      store: RoomRepoStore;
      roomId: string;
    }
  >();
  /** Same original still-awaited private merge operation; no Store DTO or namespace alone grants this lookup. */
  function readOriginalRoomMergeStoreOperation(
    context: InstallationRoomMutationContext,
    store: RoomRepoStore,
    db: Db
  ): Readonly<{ roomId: string }> | undefined {
    const operation = originalMergeStoreOperations.get(context);
    if (!operation || operation.store !== store || operation.owning.db !== db) return undefined;
    requireRoomMergeServiceOwner(
      operation.service,
      operation.owning.owner,
      db,
      operation.owning.rooms
    );
    const roots = readInstallationRoomMutationRoots(context);
    requireInstallationRoomMutationTarget(context, roots.homePath);
    if (originalMergeStoreOperations.get(context) !== operation) return undefined;
    return Object.freeze({ roomId: operation.roomId });
  }

  /** Route captures only through the actual constructor-owned service and verified HTTP composition. */
  function captureRoomMergeHttpOperation(
    service: RoomMergeService,
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    roomId: string
  ): Promise<object> {
    const binding = originalMergeServices.get(service);
    if (!binding) return Promise.reject(new DocChannelNotFoundError());
    requireRoomMergeServiceOwner(
      service,
      binding.owning.owner,
      binding.owning.db,
      binding.owning.rooms
    );
    binding.preflight();
    return captureDocHttpRoomRepoCaller(binding.owning.owner, service, req, res, roomId, 'merge');
  }

  return Object.freeze({
    nativeMergeOperations,
    originalMergeServices,
    originalMergeStoreOperations,
    requireRoomMergeServiceOwner,
    requireRoomMergeRegistryConstruction,
    executeRoomHttpMerge,
    executeRoomNativeMerge,
    requireOriginalRoomNativeMergeCurrent,
    readOriginalRoomMergeStoreOperation,
    captureRoomMergeHttpOperation,
  });
}
