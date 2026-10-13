import type { DocDownstreamAuthority } from '../../../downstream/service.js';
import type { DocCheckboxAuthority } from '../../authority.js';
import type { DocChannelService } from '../../../service.js';
import type { DocChannelGrants, DocGrantResult } from '../../../grants.js';
import type { TrustedTreeRoot, TreeRootIdentity } from '../../mutation-roots.js';

import type { DocChannelDownstream } from '../../../downstream/service.js';
import type { OriginalDownstreamRoomEmitter } from '../../../downstream/native-room-emitter.js';
/** One fixed owning installation gate, canonical coordinator and same-Db fence. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '@dorkos/db';
import type { WriteFileRequest } from '@dorkos/shared/schemas';
import type { DocChannelStore } from '../../../store.js';
import type { InstallationMutations, OwnedMutation } from '../../installation-mutations.js';
import type {
  CanonicalFileWriteCoordinator,
  CanonicalFileIdentity,
  CanonicalWriteLease,
} from '../../canonical-writer.js';
import type { CheckboxWriteFence } from '../../checkbox-fence.js';
import type { NormalFileSaveOutcome } from '../../normal-file-save.js';
import type { InstallationRoomWrites } from '../../installation-room-writes.js';
import type { RoomRepoStore } from '../../../../../rooms/repo/room-repo-store.js';

import type { InstallationHttpFileWrites } from '../../installation-http-file-writes.js';
import type { DocCheckboxWriteService } from '../../checkbox-service.js';
import type { createOriginalDocTokenFileSourceReader } from '../../../tokens/token-native-file-source.js';
import type { OriginalCheckboxGrantPreparation } from '../../checkbox/checkbox-grant-preparation.js';

import type { InstallationFileWrites } from '../../installation-file-writes.js';

/** Original captured installation assembly; declarations never register ownership. */
export interface Assembly {
  managementSourceReader?: ReturnType<typeof createOriginalDocTokenFileSourceReader>;
  db: Db;
  store: DocChannelStore;
  root: string;
  installation: InstallationMutations;
  coordinator: CanonicalFileWriteCoordinator;
  fence: CheckboxWriteFence;
  rooms?: InstallationRoomWrites;
  httpFiles?: InstallationHttpFileWrites;
  roomRepos?: RoomRepoStore;
  downstream?: Readonly<{
    downstream: DocChannelDownstream;
    emitter: OriginalDownstreamRoomEmitter;
    stop: () => Promise<void>;
  }>;
  downstreamConstruction?: 'constructing' | 'finished';
  downstreamConstructed?: Promise<void>;
  checkbox?: Readonly<{ writer: DocCheckboxWriteService; stop: () => Promise<void> }>;
  checkboxConstruction?: 'constructing' | 'finished';
  checkboxConstructed?: Promise<void>;
  checkboxGrant?: Readonly<{ helper: OriginalCheckboxGrantPreparation; stop: () => Promise<void> }>;
  checkboxGrantConstruction?: 'constructing' | 'finished';
  checkboxGrantConstructed?: Promise<void>;
  requireAdmission(): void;
  saveHttp(
    req: IncomingMessage,
    res: ServerResponse,
    input: WriteFileRequest
  ): Promise<NormalFileSaveOutcome>;
  stop(): Promise<void>;
}
/** Original live canonical save obligations retained only by the private scope registry. */
export interface SaveScope {
  owner: InstallationFileWrites;
  assembly: Assembly;
  caller: object;
  owned: OwnedMutation;
  input: Readonly<WriteFileRequest>;
  identity: CanonicalFileIdentity;
  lease: CanonicalWriteLease;
  forceConflict: boolean;
  replacements: WeakSet<CanonicalFileIdentity>;
  active: boolean;
  completedSave?: Extract<NormalFileSaveOutcome, { ok: true }>;
}

/** Exact nameable original installation custody; only the root retains its actual instance. */
export interface InstallationFileCustody {
  readonly owners: WeakMap<object, Assembly>;
  readonly connections: WeakMap<object, InstallationFileWrites>;
  readonly nativeClients: WeakMap<Db, Db['$client']>;
  readonly scopes: WeakMap<object, SaveScope>;
  readonly originalCheckboxChildren: WeakMap<
    DocCheckboxWriteService,
    { owner: InstallationFileWrites; assembly: Assembly }
  >;
  readonly originalCheckboxGrantChildren: WeakMap<
    OriginalCheckboxGrantPreparation,
    { owner: InstallationFileWrites; assembly: Assembly }
  >;
  outsideSql(db: Db, native?: Db['$client']): void;
  hostRoot(db: Db, root: TrustedTreeRoot): Promise<TreeRootIdentity>;
  physical(db: Db, path: string): Promise<CanonicalFileIdentity>;
  same(a: CanonicalFileIdentity, b: CanonicalFileIdentity): boolean;
  requireInstallationFileWritesOwner(
    owner: unknown,
    exactDb: Db,
    exactStore: DocChannelStore
  ): undefined;
  requireInstallationFileWritesAdmission(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore
  ): undefined;
  requireInstallationFileRoomWriter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    repos: RoomRepoStore,
    writer: InstallationRoomWrites
  ): undefined;
  requireInstallationHttpFileWriter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    writer: InstallationHttpFileWrites
  ): undefined;
  readInstallationHttpFileWrites(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore
  ): InstallationHttpFileWrites;
  readInstallationFileRoomWrites(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    repos: RoomRepoStore
  ): InstallationRoomWrites;
  requireInstallationFileWriteAssembly(
    owner: InstallationFileWrites,
    exactDb: Db,
    exactStore: DocChannelStore
  ): Readonly<Pick<Assembly, 'installation' | 'coordinator' | 'fence'>>;
  createInstallationOriginalRoomDownstream(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    authority: DocDownstreamAuthority,
    principals: object
  ): DocChannelDownstream;
  readInstallationOriginalRoomEmitter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    principals: object
  ): OriginalDownstreamRoomEmitter;
  createInstallationOriginalCheckboxWriter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    authority: DocCheckboxAuthority,
    service: DocChannelService
  ): DocCheckboxWriteService;
  requireInstallationOriginalCheckboxWriter(
    writer: DocCheckboxWriteService,
    db: Db,
    store: DocChannelStore,
    coordinator: CanonicalFileWriteCoordinator
  ): undefined;
  createInstallationOriginalCheckboxGrantPreparation(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    authority: DocCheckboxAuthority,
    service: DocChannelService,
    grants: DocChannelGrants
  ): OriginalCheckboxGrantPreparation;
  requireInstallationOriginalCheckboxGrantPreparation(
    helper: OriginalCheckboxGrantPreparation,
    db: Db,
    store: DocChannelStore,
    coordinator: CanonicalFileWriteCoordinator
  ): undefined;
  approveInstallationOriginalDocRoute(
    owner: InstallationFileWrites,
    grants: DocChannelGrants,
    raw: unknown,
    actor: import('../../../authorization.js').DocChannelActor,
    approvalToken?: string
  ): Promise<DocGrantResult>;
  stopInstallationOriginalCheckboxWriter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore
  ): Promise<void>;
  runInstallationFileSave(
    owner: InstallationFileWrites,
    exactDb: Db,
    exactStore: DocChannelStore,
    req: IncomingMessage,
    res: ServerResponse,
    input: WriteFileRequest
  ): Promise<NormalFileSaveOutcome>;
  stopInstallationFileWrites(
    owner: InstallationFileWrites,
    exactDb: Db,
    exactStore: DocChannelStore
  ): Promise<void>;
  readInstallationFileSaveScope(handle: object): Readonly<{
    input: Readonly<WriteFileRequest>;
    identity: Readonly<CanonicalFileIdentity>;
    lease: CanonicalWriteLease;
    forceConflict: boolean;
  }>;
  readOriginalDocumentFileSave(
    handle: object,
    db: Db,
    store: DocChannelStore
  ): Readonly<{ input: Readonly<WriteFileRequest>; identity: Readonly<CanonicalFileIdentity> }>;
  readOriginalDocumentFileSaveIdentity(
    handle: object,
    store: DocChannelStore
  ): NonNullable<WriteFileRequest['documentSave']>;
  readOriginalDocumentFileSaveCurrent(
    handle: object,
    db: Db,
    store: DocChannelStore
  ): Readonly<{ request: NonNullable<WriteFileRequest['documentSave']>; path: string }>;
  requireOriginalDocumentFileSaveCompleted(
    handle: object,
    db: Db,
    store: DocChannelStore,
    hash: string
  ): void;
  requireInstallationFileSaveCurrent(handle: object): undefined;
  checkInstallationFileSaveScope(handle: object): Promise<void>;
  markInstallationFileSaveReplaced(handle: object, replacement: CanonicalFileIdentity): undefined;
  checkInstallationFileSaveCleanup(handle: object): Promise<void>;
}

/** Original scope map and guard callbacks retrievable only with the private factory key. */
export interface InstallationFileSaveScopePorts {
  readonly scopes: InstallationFileCustody['scopes'];
  readonly outsideSql: InstallationFileCustody['outsideSql'];
  readonly physical: InstallationFileCustody['physical'];
  readonly same: InstallationFileCustody['same'];
  readonly requireInstallationFileWritesOwner: InstallationFileCustody['requireInstallationFileWritesOwner'];
}
