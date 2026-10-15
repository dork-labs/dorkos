import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { Db } from '@dorkos/db';
import type { DocChannelStore } from '../store.js';
import { readRoomRepoConfig } from '../../../rooms/repo/room-repo-config.js';
import { RoomError } from '../../../rooms/data/room-errors.js';
import {
  requireRoomRepoStoreDatabase,
  readOwnedRoomRepoSource,
  type RoomRepoStore,
} from '../../../rooms/repo/room-repo-store.js';
import {
  requireRoomRepoMutex,
  requireRoomRepoMutationLease,
  runOwnedRoomRepoMutation,
  type RoomRepoMutex,
} from '../../../rooms/repo/room-repo-mutex.js';
import {
  requireInstallationFileWriteAssembly,
  requireInstallationFileWritesAdmission,
  type InstallationFileWrites,
} from './installation-file-writes.js';
import { withRecognizedInstallationMutation } from './installation-mutations.js';
import {
  withRecognizedCanonicalFiles,
  type CanonicalFileIdentity,
  type CanonicalWriteLease,
} from './canonical-writer.js';
import { createIsolatedInstallationRoomScopeCustody } from './installation/room/installation-room-scope-custody.js';
import * as roomContexts from './installation/room/installation-room-mutation-contexts.js';
import type {
  RoomScope,
  InstallationRoomScopeCustody,
  OriginalRoomMutationPorts,
  OriginalRoomMutationRecord,
} from './installation/room/installation-room-custody-types.js';
/** Internal original room exclusion/data ownership; this never grants document or editor permission. */
/** Private context carries existing exclusion only; caller/domain permission remains original owning policy. */
export type { InstallationRoomMutationContext } from './installation/room/installation-room-custody-types.js';
const originalRoomScopeCustody = createIsolatedInstallationRoomScopeCustody();
const { owners, scopes, nativeCurrent } = originalRoomScopeCustody;
const originalRoomMutationKey = Object.freeze({});
const originalRoomMutationViews = new WeakMap<object, OriginalRoomMutationPorts>();
const originalRoomMutationGet = WeakMap.prototype.get;
const originalRoomMutationSet = WeakMap.prototype.set;
const originalRoomMutationApply = Reflect.apply;
const mutationContexts = new WeakMap<object, OriginalRoomMutationRecord>();
originalRoomMutationApply(originalRoomMutationSet, originalRoomMutationViews, [
  originalRoomMutationKey,
  Object.freeze({
    mutationContexts,
    scopeOf: originalRoomScopeCustody.scopeOf,
    within: originalRoomScopeCustody.within,
    requireInstallationRoomNamespaceCurrent:
      originalRoomScopeCustody.requireInstallationRoomNamespaceCurrent,
    checkInstallationRoomScope: originalRoomScopeCustody.checkInstallationRoomScope,
  }),
]);
/** Refuse public/fake/proxy keys before exposing actual original Room context ports. */
export function readOriginalInstallationRoomMutationPorts(
  owner: object
): OriginalRoomMutationPorts {
  const ports = originalRoomMutationApply(originalRoomMutationGet, originalRoomMutationViews, [
    owner,
  ]) as OriginalRoomMutationPorts | undefined;
  if (!ports) throw new Error('Unknown original installation Room mutation owner.');
  return ports;
}
/** Original Room operation retained on its actual isolated scope instance. */
export const requireInstallationRoomWrites: InstallationRoomScopeCustody['requireInstallationRoomWrites'] =
  originalRoomScopeCustody.requireInstallationRoomWrites;

/** Original Room operation retained on its actual isolated scope instance. */
export const readInstallationRoomFileWriteOwner: InstallationRoomScopeCustody['readInstallationRoomFileWriteOwner'] =
  originalRoomScopeCustody.readInstallationRoomFileWriteOwner;

/** Original Room operation retained on its actual isolated scope instance. */
export const readInstallationRoomSourceLease: InstallationRoomScopeCustody['readInstallationRoomSourceLease'] =
  originalRoomScopeCustody.readInstallationRoomSourceLease;

/** Original Room operation retained on its actual isolated scope instance. */
export const checkInstallationRoomScope: InstallationRoomScopeCustody['checkInstallationRoomScope'] =
  originalRoomScopeCustody.checkInstallationRoomScope;

/** Original Room operation retained on its actual isolated scope instance. */
export const requireInstallationRoomNamespaceCurrent: InstallationRoomScopeCustody['requireInstallationRoomNamespaceCurrent'] =
  originalRoomScopeCustody.requireInstallationRoomNamespaceCurrent;

/** Original Room operation retained on its actual isolated scope instance. */
export const withRecognizedInstallationRoomFiles: InstallationRoomScopeCustody['withRecognizedInstallationRoomFiles'] =
  originalRoomScopeCustody.withRecognizedInstallationRoomFiles;

/** Original Room operation retained on its actual isolated scope instance. */
export const withRecognizedInstallationRoomNamespace: InstallationRoomScopeCustody['withRecognizedInstallationRoomNamespace'] =
  originalRoomScopeCustody.withRecognizedInstallationRoomNamespace;

/** Original Room operation retained on its actual isolated scope instance. */
export const withRecognizedInstallationRoomFileEditor: InstallationRoomScopeCustody['withRecognizedInstallationRoomFileEditor'] =
  originalRoomScopeCustody.withRecognizedInstallationRoomFileEditor;

/** Original Room operation retained on its actual isolated scope instance. */
export const withRecognizedInstallationRoomRepo: InstallationRoomScopeCustody['withRecognizedInstallationRoomRepo'] =
  originalRoomScopeCustody.withRecognizedInstallationRoomRepo;

/** Original Room operation retained on its actual isolated scope instance. */
export const withRecognizedInstallationRoomMerge: InstallationRoomScopeCustody['withRecognizedInstallationRoomMerge'] =
  originalRoomScopeCustody.withRecognizedInstallationRoomMerge;

/** Original Room operation retained on its actual isolated scope instance. */
export const requireInstallationRoomStopOutside: InstallationRoomScopeCustody['requireInstallationRoomStopOutside'] =
  originalRoomScopeCustody.requireInstallationRoomStopOutside;

/** Original Room operation retained on its actual isolated scope instance. */
export const stopRecognizedInstallationRoomWrites: InstallationRoomScopeCustody['stopRecognizedInstallationRoomWrites'] =
  originalRoomScopeCustody.stopRecognizedInstallationRoomWrites;

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomMutationContext: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomMutationContext> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomMutationContext> = (...args) =>
  roomContexts.readInstallationRoomMutationContext(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomHttpMutationContext: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomHttpMutationContext> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomHttpMutationContext> = (...args) =>
  roomContexts.readInstallationRoomHttpMutationContext(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomRepoMutationContext: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomRepoMutationContext> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomRepoMutationContext> = (...args) =>
  roomContexts.readInstallationRoomRepoMutationContext(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomNativeMergeMutationContext: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomNativeMergeMutationContext> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomNativeMergeMutationContext> = (...args) =>
  roomContexts.readInstallationRoomNativeMergeMutationContext(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomPlacementMutationContext: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomPlacementMutationContext> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomPlacementMutationContext> = (...args) =>
  roomContexts.readInstallationRoomPlacementMutationContext(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomLaunchMutationContext: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomLaunchMutationContext> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomLaunchMutationContext> = (...args) =>
  roomContexts.readInstallationRoomLaunchMutationContext(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomMaintenanceMutationContext: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomMaintenanceMutationContext> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomMaintenanceMutationContext> = (...args) =>
  roomContexts.readInstallationRoomMaintenanceMutationContext(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const requireInstallationRoomLaunchTarget: (
  ...args: Parameters<typeof roomContexts.requireInstallationRoomLaunchTarget> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.requireInstallationRoomLaunchTarget> = (...args) =>
  roomContexts.requireInstallationRoomLaunchTarget(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomMutationRoots: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomMutationRoots> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomMutationRoots> = (...args) =>
  roomContexts.readInstallationRoomMutationRoots(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomStoreRoots: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomStoreRoots> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomStoreRoots> = (...args) =>
  roomContexts.readInstallationRoomStoreRoots(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const requireInstallationRoomMutationTarget: (
  ...args: Parameters<typeof roomContexts.requireInstallationRoomMutationTarget> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.requireInstallationRoomMutationTarget> = (...args) =>
  roomContexts.requireInstallationRoomMutationTarget(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const checkInstallationRoomMutationTarget: (
  ...args: Parameters<typeof roomContexts.checkInstallationRoomMutationTarget> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.checkInstallationRoomMutationTarget> = (...args) =>
  roomContexts.checkInstallationRoomMutationTarget(originalRoomMutationKey, ...args);

/** Original Room context operation retained behind the actual inaccessible root key. */
export const readInstallationRoomUploadStagingRoot: (
  ...args: Parameters<typeof roomContexts.readInstallationRoomUploadStagingRoot> extends [
    object,
    ...infer Args,
  ]
    ? Args
    : never
) => ReturnType<typeof roomContexts.readInstallationRoomUploadStagingRoot> = (...args) =>
  roomContexts.readInstallationRoomUploadStagingRoot(originalRoomMutationKey, ...args);

/** Own Room file and namespace mutations for one original installation. */
export class InstallationRoomWrites {
  #closed = false;
  #draining?: Promise<void>;
  readonly #active = new Set<Promise<unknown>>();
  readonly #context = new AsyncLocalStorage<boolean>();
  constructor(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    repos: RoomRepoStore,
    mutex: RoomRepoMutex
  ) {
    requireInstallationFileWritesAdmission(owner, db, store);
    requireRoomRepoStoreDatabase(repos, db);
    requireRoomRepoMutex(mutex);
    owners.set(this, {
      writer: this,
      owner,
      db,
      store,
      repos,
      mutex,
      native: db.$client,
      files: (roomId, paths, work) => this.#admit('files', roomId, [...paths], work),
      namespace: (roomId, work, kind) => this.#admit('opaque', roomId, [], work, kind),
      stop: () => this.#stop(),
      requireStopOutside: () => {
        if (this.#context.getStore()) throw new Error('Recursive owning room writer stop.');
      },
    });
  }
  #admit<T>(
    mode: 'files' | 'opaque',
    roomId: string,
    paths: readonly string[],
    work: (scope: object) => Promise<T>,
    kind?: 'file-editor' | 'repo' | 'merge'
  ): Promise<T> {
    const binding = owners.get(this)!;
    if (this.#context.getStore())
      return Promise.reject(new Error('Recursive owning room mutation.'));
    if (this.#closed) return Promise.reject(new Error('Owning room writes are stopped.'));
    requireInstallationFileWritesAdmission(binding.owner, binding.db, binding.store);
    nativeCurrent(binding);
    const operation = this.#context.run(true, () =>
      Promise.resolve().then(() => this.#run(mode, roomId, paths, work, kind))
    );
    this.#active.add(operation);
    void operation.then(
      () => this.#active.delete(operation),
      () => this.#active.delete(operation)
    );
    return operation;
  }
  async #run<T>(
    mode: 'files' | 'opaque',
    roomId: string,
    paths: readonly string[],
    work: (scope: object) => Promise<T>,
    kind?: 'file-editor' | 'repo' | 'merge'
  ): Promise<T> {
    const binding = owners.get(this)!;
    nativeCurrent(binding);
    const waitMs = readRoomRepoConfig().mergeQueueWaitMs;
    nativeCurrent(binding);
    return runOwnedRoomRepoMutation(
      binding.mutex,
      roomId,
      {
        waitMs,
        busy: () =>
          new RoomError(
            'MERGE_IN_FLIGHT',
            kind === 'file-editor'
              ? 'Someone else is writing to this room’s files right now, and the wait ran out. Try again in a moment.'
              : kind === 'repo'
                ? 'This room’s files are busy — something else is writing to them. Try again in a moment.'
                : kind === 'merge'
                  ? 'Someone else is merging into this room right now, and the wait ran out. Try again in a moment.'
                  : 'Someone else is writing to this room’s files right now. Try again in a moment.'
          ),
        ...(kind === 'file-editor' || kind === 'merge'
          ? {
              queueFull: () =>
                new RoomError(
                  'MERGE_IN_FLIGHT',
                  kind === 'merge'
                    ? 'This room already has as many merges queued as it will hold, so this one was not added to the queue. Wait for them to land, then merge again.'
                    : 'This room’s files already have as many changes queued as they will hold. Wait for them to land, then try again.'
                ),
            }
          : {}),
      },
      async (roomLease) => {
        nativeCurrent(binding);
        requireRoomRepoMutationLease(binding.mutex, roomId, roomLease);
        const source = readOwnedRoomRepoSource(binding.repos, binding.db, roomId);
        if (mode === 'files' && !source.row)
          throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
        const assembly = requireInstallationFileWriteAssembly(
          binding.owner,
          binding.db,
          binding.store
        );
        // The actual configured installation data home is an existing root at server construction.
        // Gate reservation precedes every filesystem observation, including absent room creation.
        return withRecognizedInstallationMutation(
          assembly.installation,
          mode,
          [{ directory: path.dirname(source.root) }],
          async (owned) => {
            nativeCurrent(binding);
            requireRoomRepoMutationLease(binding.mutex, roomId, roomLease);
            const enter = async (
              identities: readonly CanonicalFileIdentity[],
              lease?: CanonicalWriteLease
            ): Promise<T> => {
              const handle = Object.freeze({});
              const scope: RoomScope = {
                writer: this,
                binding,
                roomId,
                roomLease,
                owned,
                source: readOwnedRoomRepoSource(binding.repos, binding.db, roomId),
                identities,
                lease,
                active: true,
              };
              scopes.set(handle, scope);
              try {
                await checkInstallationRoomScope(this, roomId, handle);
                return await work(handle);
              } finally {
                scope.active = false;
                scopes.delete(handle);
              }
            };
            return mode === 'files'
              ? withRecognizedCanonicalFiles(assembly.coordinator, paths, enter)
              : enter([]);
          }
        );
      }
    );
  }
  #stop(): Promise<void> {
    if (this.#context.getStore())
      return Promise.reject(new Error('Recursive owning room writer stop.'));
    if (!this.#draining) {
      this.#closed = true;
      this.#draining = Promise.allSettled([...this.#active]).then(() => {});
    }
    return this.#draining;
  }
}
