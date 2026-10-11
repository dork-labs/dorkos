/** One fixed owning installation gate, canonical coordinator and same-Db fence. */
import { types as utilTypes } from 'node:util';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { Db } from '@dorkos/db';
import { WriteFileRequestSchema, type WriteFileRequest } from '@dorkos/shared/schemas';
import { getBoundary } from '../../../../lib/boundary.js';
import { resolveWithinCwd } from '../../../../lib/file-route-guards.js';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../store.js';
import {
  captureDocHttpFileWriteCaller,
  requireDocHttpFileWriteCurrent,
  retireDocHttpFileWriteCaller,
  prepareDocHttpDocumentSave,
  completeDocHttpDocumentSave,
} from '../http-composition.js';
import {
  InstallationMutations,
  withRecognizedInstallationMutation,
  stopRecognizedInstallationMutations,
} from './installation-mutations.js';
import {
  CanonicalFileWriteCoordinator,
  withRecognizedCanonicalFiles,
  stopRecognizedCanonicalWriter,
  CanonicalFileIdentityChangedError,
} from './canonical-writer.js';
import { CheckboxWriteFence, assertRecognizedCheckboxAdmission } from './checkbox-fence.js';
import { performNormalFileSave, type NormalFileSaveOutcome } from './normal-file-save.js';
import {
  InstallationRoomWrites,
  stopRecognizedInstallationRoomWrites,
  requireInstallationRoomStopOutside,
} from './installation-room-writes.js';
import {
  requireRoomRepoStoreDatabase,
  type RoomRepoStore,
} from '../../../rooms/repo/room-repo-store.js';
import { requireRoomRepoMutex, type RoomRepoMutex } from '../../../rooms/repo/room-repo-mutex.js';

import {
  InstallationHttpFileWrites,
  requireInstallationHttpFileStopOutside,
  stopRecognizedInstallationHttpFileWrites,
} from './installation-http-file-writes.js';

import { createIsolatedInstallationFileWriteCustody } from './installation/file/installation-file-custody.js';
import type { SaveScope } from './installation/file/installation-file-custody-types.js';

const originalFileCustody = createIsolatedInstallationFileWriteCustody();
const {
  owners,
  connections,
  nativeClients,
  scopes,
  originalCheckboxChildren,
  originalCheckboxGrantChildren,
  outsideSql,
  hostRoot,
  physical,
  same,
} = originalFileCustody;
/** Original installation custody API backed by the sole private instance. */
export const requireInstallationFileWritesOwner =
  originalFileCustody.requireInstallationFileWritesOwner;
/** Original installation custody API backed by the sole private instance. */
export const requireInstallationFileWritesAdmission =
  originalFileCustody.requireInstallationFileWritesAdmission;
/** Original installation custody API backed by the sole private instance. */
export const requireInstallationFileRoomWriter =
  originalFileCustody.requireInstallationFileRoomWriter;
/** Original installation custody API backed by the sole private instance. */
export const requireInstallationHttpFileWriter =
  originalFileCustody.requireInstallationHttpFileWriter;
/** Original installation custody API backed by the sole private instance. */
export const readInstallationHttpFileWrites = originalFileCustody.readInstallationHttpFileWrites;
/** Original installation custody API backed by the sole private instance. */
export const readInstallationFileRoomWrites = originalFileCustody.readInstallationFileRoomWrites;
/** Original installation custody API backed by the sole private instance. */
export const requireInstallationFileWriteAssembly =
  originalFileCustody.requireInstallationFileWriteAssembly;
/** Original installation custody API backed by the sole private instance. */
export const createInstallationOriginalRoomDownstream =
  originalFileCustody.createInstallationOriginalRoomDownstream;
/** Original installation custody API backed by the sole private instance. */
export const readInstallationOriginalRoomEmitter =
  originalFileCustody.readInstallationOriginalRoomEmitter;
/** Original installation custody API backed by the sole private instance. */
export const createInstallationOriginalCheckboxWriter =
  originalFileCustody.createInstallationOriginalCheckboxWriter;
/** Original installation custody API backed by the sole private instance. */
export const requireInstallationOriginalCheckboxWriter =
  originalFileCustody.requireInstallationOriginalCheckboxWriter;
/** Original installation custody API backed by the sole private instance. */
export const createInstallationOriginalCheckboxGrantPreparation =
  originalFileCustody.createInstallationOriginalCheckboxGrantPreparation;
/** Original installation custody API backed by the sole private instance. */
export const requireInstallationOriginalCheckboxGrantPreparation =
  originalFileCustody.requireInstallationOriginalCheckboxGrantPreparation;
/** Original installation custody API backed by the sole private instance. */
export const approveInstallationOriginalDocRoute =
  originalFileCustody.approveInstallationOriginalDocRoute;
/** Original installation custody API backed by the sole private instance. */
export const stopInstallationOriginalCheckboxWriter =
  originalFileCustody.stopInstallationOriginalCheckboxWriter;
/** Original installation custody API backed by the sole private instance. */
export const runInstallationFileSave = originalFileCustody.runInstallationFileSave;
/** Original installation custody API backed by the sole private instance. */
export const stopInstallationFileWrites = originalFileCustody.stopInstallationFileWrites;
/** Original installation custody API backed by the sole private instance. */
export const readInstallationFileSaveScope = originalFileCustody.readInstallationFileSaveScope;
/** Original installation custody API backed by the sole private instance. */
export const readOriginalDocumentFileSave = originalFileCustody.readOriginalDocumentFileSave;
/** Original installation custody API backed by the sole private instance. */
export const readOriginalDocumentFileSaveIdentity =
  originalFileCustody.readOriginalDocumentFileSaveIdentity;
/** Original installation custody API backed by the sole private instance. */
export const readOriginalDocumentFileSaveCurrent =
  originalFileCustody.readOriginalDocumentFileSaveCurrent;
/** Original installation custody API backed by the sole private instance. */
export const requireOriginalDocumentFileSaveCompleted =
  originalFileCustody.requireOriginalDocumentFileSaveCompleted;
/** Original installation custody API backed by the sole private instance. */
export const requireInstallationFileSaveCurrent =
  originalFileCustody.requireInstallationFileSaveCurrent;
/** Original installation custody API backed by the sole private instance. */
export const checkInstallationFileSaveScope = originalFileCustody.checkInstallationFileSaveScope;
/** Original installation custody API backed by the sole private instance. */
export const markInstallationFileSaveReplaced =
  originalFileCustody.markInstallationFileSaveReplaced;
/** Original installation custody API backed by the sole private instance. */
export const checkInstallationFileSaveCleanup =
  originalFileCustody.checkInstallationFileSaveCleanup;

/** Own original installation file writes and drain their existing active lifetimes on shutdown. */
export class InstallationFileWrites {
  #closed = false;
  #draining?: Promise<void>;
  readonly #active = new Set<Promise<unknown>>();
  constructor(input: {
    db: Db;
    store: DocChannelStore;
    roomRepos?: RoomRepoStore;
    roomMutex?: RoomRepoMutex;
  }) {
    if (utilTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype)
      throw new Error('File writer dependencies must be plain own data.');
    const dbField = Object.getOwnPropertyDescriptor(input, 'db');
    const storeField = Object.getOwnPropertyDescriptor(input, 'store');
    if (!dbField || !('value' in dbField) || !storeField || !('value' in storeField))
      throw new Error('File writer dependencies must be own data.');
    const db: Db = dbField.value;
    const store: DocChannelStore = storeField.value;
    requireDocChannelStoreDatabase(store, db);
    const roomField = Object.getOwnPropertyDescriptor(input, 'roomRepos');
    const mutexField = Object.getOwnPropertyDescriptor(input, 'roomMutex');
    if (
      !!roomField !== !!mutexField ||
      (roomField && !('value' in roomField)) ||
      (mutexField && !('value' in mutexField))
    )
      throw new Error('Owning room dependencies must be exact own data together.');
    const roomRepos: RoomRepoStore | undefined = roomField?.value;
    const roomMutex: RoomRepoMutex | undefined = mutexField?.value;
    if (roomField) {
      requireRoomRepoStoreDatabase(roomRepos, db);
      requireRoomRepoMutex(roomMutex);
    }
    const native = db.$client;
    outsideSql(db, native);
    if (connections.has(db.$client))
      throw new Error('This native database already owns file writes.');
    const root = getBoundary();
    const installation = new InstallationMutations({ resolve: (root) => hostRoot(db, root) });
    const coordinator = new CanonicalFileWriteCoordinator({
      resolve: (path) => physical(db, path),
      assertOutsideTransaction: () => outsideSql(db),
    });
    owners.set(this, {
      db,
      store,
      root,
      installation,
      coordinator,
      fence: new CheckboxWriteFence(db, store),
      requireAdmission: () => {
        if (this.#closed) throw new Error('File writes are stopped.');
      },
      saveHttp: (req, res, input) => this.#admit(req, res, input),
      stop: () => this.#stop(),
    });
    connections.set(native, this);
    nativeClients.set(db, native);
    owners.get(this)!.httpFiles = new InstallationHttpFileWrites(this, db, store);
    if (roomRepos && roomMutex) {
      const assembly = owners.get(this)!;
      assembly.roomRepos = roomRepos;
      assembly.rooms = new InstallationRoomWrites(this, db, store, roomRepos, roomMutex);
    }
  }

  saveHttp(req: Request, res: Response, raw: WriteFileRequest): Promise<NormalFileSaveOutcome> {
    return this.#admit(req, res, raw);
  }

  #admit(req: Request, res: Response, raw: WriteFileRequest): Promise<NormalFileSaveOutcome> {
    if (this.#closed) return Promise.reject(new Error('File writes are stopped.'));
    // Parse/copy all request data before admission; no mutable caller object survives awaits.
    const input = Object.freeze(WriteFileRequestSchema.parse(raw));
    const assembly = owners.get(this)!;
    outsideSql(assembly.db);
    const caller = captureDocHttpFileWriteCaller(this, req, res);
    const operation = Promise.resolve().then(() => this.#save(input, caller));
    this.#active.add(operation);
    void operation.then(
      () => this.#active.delete(operation),
      () => this.#active.delete(operation)
    );
    return operation;
  }

  async #save(input: Readonly<WriteFileRequest>, caller: object) {
    const assembly = owners.get(this)!;
    let failed = false;
    let firstCause: unknown;
    let result: NormalFileSaveOutcome | undefined;
    try {
      outsideSql(assembly.db);
      // The initialized host boundary is exclusion scope, never document permission.
      const root = assembly.root;
      if (getBoundary() !== root) throw new Error('Installed file boundary changed.');
      result = await withRecognizedInstallationMutation(
        assembly.installation,
        'files',
        [{ directory: root }],
        async (owned) => {
          requireDocHttpFileWriteCurrent(this, caller);
          const { resolved } = await resolveWithinCwd(input.cwd, input.path);
          outsideSql(assembly.db);
          owned.assertActive();
          requireDocHttpFileWriteCurrent(this, caller);
          let entered = false;
          const run = (forceConflict: boolean) =>
            withRecognizedCanonicalFiles(
              assembly.coordinator,
              [resolved],
              async (identities, lease) => {
                entered = true;
                const handle = Object.freeze({});
                const scope: SaveScope = {
                  owner: this,
                  assembly,
                  caller,
                  owned,
                  input,
                  identity: { ...identities[0]! },
                  lease,
                  forceConflict,
                  replacements: new WeakSet(),
                  active: true,
                };
                scope.lease = {
                  async reserveReplacement(path) {
                    requireInstallationFileSaveCurrent(handle);
                    const actual = await lease.reserveReplacement(path);
                    requireInstallationFileSaveCurrent(handle);
                    assertRecognizedCheckboxAdmission(
                      assembly.fence,
                      assembly.db,
                      assembly.store,
                      actual
                    );
                    const replacement = Object.freeze({ ...actual });
                    scope.replacements.add(replacement);
                    return replacement;
                  },
                };
                scopes.set(handle, scope);
                try {
                  await checkInstallationFileSaveScope(handle);
                  if (input.documentSave) {
                    const retained = await prepareDocHttpDocumentSave(this, caller, handle);
                    if (retained) return retained;
                    await checkInstallationFileSaveScope(handle);
                  }
                  const outcome = await performNormalFileSave(handle);
                  if (input.documentSave && 'ok' in outcome && outcome.effect === 'changed') {
                    // Only the actual original writer result after readback and FD/temp cleanup is retained.
                    scope.completedSave = Object.freeze({ ...outcome });
                    const documentReceipt = await completeDocHttpDocumentSave(this, caller, handle);
                    return { ...outcome, documentReceipt };
                  }
                  return outcome;
                } finally {
                  scope.active = false;
                  scopes.delete(handle);
                }
              }
            );
          try {
            return await run(false);
          } catch (error) {
            if (entered || !(error instanceof CanonicalFileIdentityChangedError)) throw error;
            // One fresh read-only lease reports current conflict bytes; never retry an effect.
            return await run(true);
          }
        }
      );
    } catch (error) {
      failed = true;
      firstCause = error;
    } finally {
      try {
        retireDocHttpFileWriteCaller(this, caller);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstCause = error;
        }
      }
    }
    if (failed) throw firstCause;
    return result!;
  }

  stop(): Promise<void> {
    return this.#stop();
  }

  #stop(): Promise<void> {
    const roomOwner = owners.get(this)!.rooms;
    const httpOwner = owners.get(this)!.httpFiles!;
    try {
      requireInstallationHttpFileStopOutside(httpOwner);
      if (roomOwner) requireInstallationRoomStopOutside(roomOwner);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#draining) return this.#draining;
    this.#closed = true;
    let drained!: () => void, refused!: (cause: unknown) => void;
    // Own the exact memo before invoking any captured child stop callback.
    this.#draining = new Promise<void>((resolve, reject) => {
      drained = resolve;
      refused = reject;
    });
    // Close each actual child admission synchronously before the first awaited save drain.
    const children = [
      () => owners.get(this)!.managementSourceReader?.requireClosed(),
      () => {
        const assembly = owners.get(this)!;
        if (assembly.downstreamConstruction === 'constructing')
          return assembly.downstreamConstructed!.then(
            () => assembly.downstream?.stop() ?? undefined
          );
        return assembly.downstream?.stop() ?? Promise.resolve();
      },
      () => {
        const assembly = owners.get(this)!;
        if (assembly.checkboxGrantConstruction === 'constructing')
          return assembly.checkboxGrantConstructed!.then(
            () => assembly.checkboxGrant?.stop() ?? undefined
          );
        return assembly.checkboxGrant?.stop() ?? Promise.resolve();
      },
      () => {
        const assembly = owners.get(this)!;
        if (assembly.checkboxConstruction === 'constructing')
          return assembly.checkboxConstructed!.then(() => assembly.checkbox?.stop() ?? undefined);
        return assembly.checkbox?.stop() ?? Promise.resolve();
      },
      () => stopRecognizedInstallationHttpFileWrites(httpOwner),
      () => (roomOwner ? stopRecognizedInstallationRoomWrites(roomOwner) : Promise.resolve()),
    ].map((stop) => {
      try {
        return Promise.resolve(stop());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    void (async () => {
      const childOutcomes = await Promise.allSettled(children);
      await Promise.allSettled([...this.#active]);
      // Already admitted caller outcomes remain theirs; child drain failure still refuses success.
      let failed = false;
      let firstCause: unknown;
      for (const value of childOutcomes)
        if (value.status === 'rejected' && !failed) {
          failed = true;
          firstCause = value.reason;
        }
      // Existing admitted work may still need nested file admission until it settles.
      const stops = await Promise.allSettled(
        [
          () => stopRecognizedInstallationMutations(owners.get(this)!.installation),
          () => stopRecognizedCanonicalWriter(owners.get(this)!.coordinator),
        ].map((stop) => {
          try {
            return Promise.resolve(stop());
          } catch (error) {
            return Promise.reject(error);
          }
        })
      );
      for (const value of stops) {
        if (value.status === 'rejected' && !failed) {
          failed = true;
          firstCause = value.reason;
        }
      }
      if (failed) throw firstCause;
    })().then(drained, refused);
    return this.#draining;
  }
}
