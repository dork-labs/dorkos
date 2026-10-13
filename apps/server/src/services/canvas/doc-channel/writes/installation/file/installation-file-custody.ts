import {
  DocChannelDownstream,
  type DocDownstreamAuthority,
  requireOriginalDownstreamRoomEmitterOwner,
} from '../../../downstream/service.js';
import type { OriginalDownstreamRoomEmitter } from '../../../downstream/native-room-emitter.js';
/** One fixed owning installation gate, canonical coordinator and same-Db fence. */
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '@dorkos/db';
import { type WriteFileRequest } from '@dorkos/shared/schemas';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../../../store.js';
import {
  MutationRefusal,
  type TrustedTreeRoot,
  type TreeRootIdentity,
} from '../../mutation-roots.js';
import {
  CanonicalFileWriteCoordinator,
  type CanonicalFileIdentity,
} from '../../canonical-writer.js';
import { type NormalFileSaveOutcome } from '../../normal-file-save.js';
import {
  InstallationRoomWrites,
  requireInstallationRoomWrites,
} from '../../installation-room-writes.js';
import { type RoomRepoStore } from '../../../../../rooms/repo/room-repo-store.js';

import {
  InstallationHttpFileWrites,
  requireInstallationHttpFileWrites,
} from '../../installation-http-file-writes.js';
import {
  DocCheckboxWriteService,
  requireOriginalCheckboxWriterAssembly,
} from '../../checkbox-service.js';
import type { DocCheckboxAuthority } from '../../authority.js';
import {
  notifyServiceOriginalCheckboxCommitted,
  type DocChannelService,
} from '../../../service.js';
import { DOC_INGEST_LIMITS } from '../../../current/accounting.js';
import {
  approveOriginalDocRoute,
  type DocChannelGrants,
  type DocGrantResult,
} from '../../../grants.js';
import { DocRouteGrantRequestSchema, declaredRoute, grantTypes } from '../../../grant-policy.js';
import { requireOriginalDocGrantStore } from '../../../store.js';
import { matchesCanvasChannelEvent } from '@dorkos/shared/canvas-channel-schemas';
import { createOriginalDocTokenFileSourceReader } from '../../../tokens/token-native-file-source.js';
import {
  OriginalCheckboxGrantPreparation,
  requireOriginalCheckboxGrantPreparationAssembly,
  requireOriginalCheckboxGrantPreparationGrants,
  grantOriginalCheckboxRoute,
} from '../../checkbox/checkbox-grant-preparation.js';

import type { InstallationFileWrites } from '../../installation-file-writes.js';
import type {
  Assembly,
  SaveScope,
  InstallationFileCustody,
  InstallationFileSaveScopePorts,
} from './installation-file-custody-types.js';
import * as saveScope from './installation-file-save-scope-operations.js';

const originalSaveScopePorts = new WeakMap<object, InstallationFileSaveScopePorts>();
const originalSaveScopeGet = WeakMap.prototype.get;
const originalSaveScopeSet = WeakMap.prototype.set;
const originalSaveScopeApply = Reflect.apply;
/** Refuse fake/public/proxy keys before exposing the original private save-scope cells. */
export function readOriginalInstallationFileSaveScopePorts(
  owner: object
): InstallationFileSaveScopePorts {
  const ports = originalSaveScopeApply(originalSaveScopeGet, originalSaveScopePorts, [owner]) as
    InstallationFileSaveScopePorts | undefined;
  if (!ports) throw new Error('Unknown original installation file save-scope owner.');
  return ports;
}

/** Every invocation owns unrelated installation custody; only the original module retains the actual instance. */
export function createIsolatedInstallationFileWriteCustody(): Readonly<InstallationFileCustody> {
  const owners = new WeakMap<object, Assembly>();
  const connections = new WeakMap<object, InstallationFileWrites>();
  const nativeClients = new WeakMap<Db, Db['$client']>();
  const scopes = new WeakMap<object, SaveScope>();
  const originalCheckboxChildren = new WeakMap<
    DocCheckboxWriteService,
    { owner: InstallationFileWrites; assembly: Assembly }
  >();
  const originalCheckboxGrantChildren = new WeakMap<
    OriginalCheckboxGrantPreparation,
    { owner: InstallationFileWrites; assembly: Assembly }
  >();

  function outsideSql(db: Db, native = nativeClients.get(db)): void {
    if (!native || db.$client !== native || !native.open)
      throw new Error('Owning native database connection changed or closed.');
    if (native.inTransaction) throw new Error('File mutation cannot await inside SQL.');
  }
  async function hostRoot(db: Db, root: TrustedTreeRoot): Promise<TreeRootIdentity> {
    outsideSql(db);
    if (!path.isAbsolute(root.directory)) throw new MutationRefusal('invalid-root');
    const canonicalPath = await realpath(root.directory);
    outsideSql(db);
    const info = await stat(canonicalPath, { bigint: true });
    outsideSql(db);
    if (!info.isDirectory()) throw new MutationRefusal('invalid-root');
    const ancestorPhysicalKeys: string[] = [];
    let parent = path.dirname(canonicalPath);
    while (parent !== canonicalPath) {
      outsideSql(db);
      const ancestor = await stat(parent, { bigint: true });
      outsideSql(db);
      if (!ancestor.isDirectory()) throw new MutationRefusal('invalid-root');
      ancestorPhysicalKeys.push(`${ancestor.dev}:${ancestor.ino}`);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return Object.freeze({
      canonicalPath,
      physicalKey: `${info.dev}:${info.ino}`,
      ancestorPhysicalKeys: Object.freeze(ancestorPhysicalKeys),
    });
  }
  async function physical(db: Db, path: string): Promise<CanonicalFileIdentity> {
    outsideSql(db);
    const canonicalPath = await realpath(path);
    outsideSql(db);
    const info = await stat(canonicalPath, { bigint: true });
    outsideSql(db);
    if (!info.isFile())
      throw Object.assign(new Error('Not a regular file'), { code: 'NOT_A_FILE' });
    return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
  }
  function same(a: CanonicalFileIdentity, b: CanonicalFileIdentity): boolean {
    return a.canonicalPath === b.canonicalPath && a.device === b.device && a.inode === b.inode;
  }
  /** Private constructor membership and exact original dependencies; no structural certification. */
  function requireInstallationFileWritesOwner(
    owner: unknown,
    exactDb: Db,
    exactStore: DocChannelStore
  ): undefined {
    const assembly = owner && typeof owner === 'object' ? owners.get(owner) : undefined;
    if (!assembly || assembly.db !== exactDb || assembly.store !== exactStore)
      throw new Error('Unknown owning file writer or database.');
    requireDocChannelStoreDatabase(exactStore, exactDb);
    if (nativeClients.get(exactDb) !== exactDb.$client)
      throw new Error('Owning native database connection changed.');
    return undefined;
  }
  /** Constructor admission guard, not a caller-provided readiness proof; existing scopes may drain after closure. */
  function requireInstallationFileWritesAdmission(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore
  ): undefined {
    requireInstallationFileWritesOwner(owner, db, store);
    outsideSql(db);
    owners.get(owner)!.requireAdmission();
    return undefined;
  }
  /** Exact captured original room instance only. No registrar or cross-module reader recursion. */
  function requireInstallationFileRoomWriter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    repos: RoomRepoStore,
    writer: InstallationRoomWrites
  ): undefined {
    requireInstallationFileWritesOwner(owner, db, store);
    const assembly = owners.get(owner)!;
    if (assembly.rooms !== writer || assembly.roomRepos !== repos)
      throw new Error('Room writer is not the original factory-captured instance.');
    return undefined;
  }
  /** Compare the exact factory-captured finite namespace instance, never another constructor. */
  function requireInstallationHttpFileWriter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    writer: InstallationHttpFileWrites
  ): undefined {
    requireInstallationFileWritesOwner(owner, db, store);
    if (owners.get(owner)!.httpFiles !== writer)
      throw new Error('Unknown original namespace writer.');
    return undefined;
  }
  /** Read the HTTP file child retained by the original installation. */
  function readInstallationHttpFileWrites(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore
  ): InstallationHttpFileWrites {
    requireInstallationFileWritesOwner(owner, db, store);
    return requireInstallationHttpFileWrites(owners.get(owner)!.httpFiles);
  }
  /** Return only this factory's actual captured original room writer, never another constructor instance. */
  function readInstallationFileRoomWrites(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    repos: RoomRepoStore
  ): InstallationRoomWrites {
    requireInstallationFileWritesOwner(owner, db, store);
    const assembly = owners.get(owner)!;
    if (!assembly.rooms || assembly.roomRepos !== repos)
      throw new Error('Owning room mutation integration is unavailable.');
    return requireInstallationRoomWrites(assembly.rooms, owner, db, store, repos);
  }
  /** Original composition receives the actual single objects, never a caller-created port. */
  function requireInstallationFileWriteAssembly(
    owner: InstallationFileWrites,
    exactDb: Db,
    exactStore: DocChannelStore
  ): Readonly<Pick<Assembly, 'installation' | 'coordinator' | 'fence'>> {
    requireInstallationFileWritesOwner(owner, exactDb, exactStore);
    const { installation, coordinator, fence } = owners.get(owner)!;
    return Object.freeze({ installation, coordinator, fence });
  }
  /** Actual installation constructor creates one retained native sender; no attached child/stop callback. */
  function createInstallationOriginalRoomDownstream(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    authority: DocDownstreamAuthority,
    principals: object
  ): DocChannelDownstream {
    requireInstallationFileWritesAdmission(owner, db, store);
    const assembly = owners.get(owner)!;
    if (assembly.downstreamConstruction)
      throw new Error('Original installation downstream already constructed.');
    assembly.downstreamConstruction = 'constructing';
    let finished!: () => void;
    assembly.downstreamConstructed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      const child = DocChannelDownstream.createInstallationDownstream(
        db,
        store,
        authority,
        principals
      );
      assembly.downstream = child;
      requireInstallationFileWritesAdmission(owner, db, store);
      return child.downstream;
    } finally {
      assembly.downstreamConstruction = 'finished';
      finished();
    }
  }
  /** Only the installation's original retained sender may enter the actual runtime constructor. */
  function readInstallationOriginalRoomEmitter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    principals: object
  ): OriginalDownstreamRoomEmitter {
    requireInstallationFileWritesAdmission(owner, db, store);
    const child = owners.get(owner)!.downstream;
    if (!child) throw new Error('Original installation Room emitter unavailable.');
    requireOriginalDownstreamRoomEmitterOwner(child.emitter, db, principals);
    requireInstallationFileWritesAdmission(owner, db, store);
    return child.emitter;
  }
  /** The owning constructor creates and retains its one actual checkbox child, never an attached callback. */
  function createInstallationOriginalCheckboxWriter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    authority: DocCheckboxAuthority,
    service: DocChannelService
  ): DocCheckboxWriteService {
    requireInstallationFileWritesAdmission(owner, db, store);
    const assembly = owners.get(owner)!;
    if (assembly.checkboxConstruction)
      throw new Error('Owning checkbox writer already constructed.');
    // Latch before any constructor/native check can reenter this factory or owner stop.
    assembly.checkboxConstruction = 'constructing';
    let finished!: () => void;
    assembly.checkboxConstructed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      const writer = new DocCheckboxWriteService(db, store, assembly.coordinator, authority, {
        policyLimits: DOC_INGEST_LIMITS,
        notifyCommitted: (_documentId) => notifyServiceOriginalCheckboxCommitted(service),
        service,
      });
      const captured = requireOriginalCheckboxWriterAssembly(
        writer,
        db,
        store,
        assembly.coordinator
      );
      // Preserve this actual constructed child in the parent drain even if admission retired during construction.
      assembly.checkbox = Object.freeze({ writer, stop: captured.stop });
      originalCheckboxChildren.set(writer, { owner, assembly });
      requireInstallationFileWritesAdmission(owner, db, store);
      if (owners.get(owner) !== assembly) throw new Error('Owning checkbox factory changed.');
      return writer;
    } finally {
      assembly.checkboxConstruction = 'finished';
      finished();
    }
  }
  /** Lookup of only the internally constructed child; a second genuine constructor is not original custody. */
  function requireInstallationOriginalCheckboxWriter(
    writer: DocCheckboxWriteService,
    db: Db,
    store: DocChannelStore,
    coordinator: CanonicalFileWriteCoordinator
  ): undefined {
    const child = originalCheckboxChildren.get(writer);
    if (!child) throw new Error('Unknown original installation checkbox writer.');
    requireInstallationFileWritesOwner(child.owner, db, store);
    if (
      owners.get(child.owner) !== child.assembly ||
      child.assembly.coordinator !== coordinator ||
      child.assembly.checkbox?.writer !== writer
    )
      throw new Error('Original installation checkbox custody changed.');
    return undefined;
  }
  /** Construct the one original FILE grant preparation after the same installation's actual writer. */
  function createInstallationOriginalCheckboxGrantPreparation(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    authority: DocCheckboxAuthority,
    service: DocChannelService,
    grants: DocChannelGrants
  ): OriginalCheckboxGrantPreparation {
    requireInstallationFileWritesAdmission(owner, db, store);
    const assembly = owners.get(owner)!;
    if (!assembly.checkbox || assembly.checkboxGrantConstruction || assembly.checkboxGrant)
      throw new Error(
        'Original checkbox grant preparation cannot be constructed twice or before its writer.'
      );
    requireInstallationOriginalCheckboxWriter(
      assembly.checkbox.writer,
      db,
      store,
      assembly.coordinator
    );
    assembly.checkboxGrantConstruction = 'constructing';
    let constructed!: () => void;
    assembly.checkboxGrantConstructed = new Promise<void>((resolve) => {
      constructed = resolve;
    });
    try {
      const helper = new OriginalCheckboxGrantPreparation(
        db,
        store,
        assembly.coordinator,
        authority,
        service,
        grants
      );
      const captured = requireOriginalCheckboxGrantPreparationAssembly(
        helper,
        db,
        store,
        assembly.coordinator
      );
      assembly.checkboxGrant = Object.freeze({ helper, stop: captured.stop });
      originalCheckboxGrantChildren.set(helper, Object.freeze({ owner, assembly }));
      requireInstallationFileWritesAdmission(owner, db, store);
      if (owners.get(owner) !== assembly) throw new Error('Owning checkbox grant factory changed.');
      return helper;
    } finally {
      assembly.checkboxGrantConstruction = 'finished';
      constructed();
    }
  }

  /** Lookup only of the internally constructed child; native SQL may consume this exact relationship. */
  function requireInstallationOriginalCheckboxGrantPreparation(
    helper: OriginalCheckboxGrantPreparation,
    db: Db,
    store: DocChannelStore,
    coordinator: CanonicalFileWriteCoordinator
  ): undefined {
    const child = originalCheckboxGrantChildren.get(helper);
    if (
      !child ||
      child.assembly.db !== db ||
      child.assembly.store !== store ||
      child.assembly.coordinator !== coordinator ||
      child.assembly.checkboxGrant?.helper !== helper ||
      owners.get(child.owner) !== child.assembly
    )
      throw new Error('Foreign original checkbox grant preparation.');
    requireInstallationFileWritesOwner(child.owner, db, store);
    return undefined;
  }

  /** Approve through the installed original source preparation, never a supplied write observation. */
  function approveInstallationOriginalDocRoute(
    owner: InstallationFileWrites,
    grants: DocChannelGrants,
    raw: unknown,
    actor: import('../../../authorization.js').DocChannelActor,
    approvalToken?: string
  ): Promise<DocGrantResult> {
    const assembly = owners.get(owner);
    if (!assembly) throw new Error('Original installation required.');
    requireInstallationFileWritesAdmission(owner, assembly.db, assembly.store);
    const helper = assembly.checkboxGrant?.helper;
    if (!helper) throw new Error('Original route preparation unavailable.');
    requireOriginalCheckboxGrantPreparationGrants(helper, grants);
    const request = DocRouteGrantRequestSchema.omit({ write: true }).parse(raw);
    const channel = requireOriginalDocGrantStore(assembly.store, assembly.db).getChannel(
      request.documentId
    );
    if (!channel) throw new Error('Original document channel unavailable.');
    const types = grantTypes(declaredRoute(channel, request.routeId), request.allowedTypes);
    const checkbox = types.some((type) => matchesCanvasChannelEvent(type, 'md.task.toggled'));
    // Comparison DATA selects the existing native preparation. Each chosen grant
    // operation independently repeats current source, manifest and approval checks.
    const reader = (assembly.managementSourceReader ??= createOriginalDocTokenFileSourceReader(
      assembly.db,
      assembly.roomRepos
    ));
    const source = reader.observe(request.documentId);
    if (source.canonicalFile !== null && checkbox)
      return grantOriginalCheckboxRoute(helper, raw, actor, approvalToken);
    return Promise.resolve(approveOriginalDocRoute(grants, request, actor, approvalToken));
  }

  /** Exact factory child only; public writer methods cannot replace its original drain. */
  function stopInstallationOriginalCheckboxWriter(
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore
  ): Promise<void> {
    requireInstallationFileWritesOwner(owner, db, store);
    const child = owners.get(owner)!.checkbox;
    if (!child) throw new Error('Owning checkbox writer is unavailable.');
    return child.stop();
  }
  /** Run a file save through the original installation owner. */
  function runInstallationFileSave(
    owner: InstallationFileWrites,
    exactDb: Db,
    exactStore: DocChannelStore,
    req: IncomingMessage,
    res: ServerResponse,
    input: WriteFileRequest
  ): Promise<NormalFileSaveOutcome> {
    requireInstallationFileWritesOwner(owner, exactDb, exactStore);
    return owners.get(owner)!.saveHttp(req, res, input);
  }
  /** Stop the original installation and drain its captured child lifetimes. */
  function stopInstallationFileWrites(
    owner: InstallationFileWrites,
    exactDb: Db,
    exactStore: DocChannelStore
  ): Promise<void> {
    requireInstallationFileWritesOwner(owner, exactDb, exactStore);
    return owners.get(owner)!.stop();
  }
  const saveScopeKey = Object.freeze({});
  originalSaveScopeApply(originalSaveScopeSet, originalSaveScopePorts, [
    saveScopeKey,
    Object.freeze({ scopes, outsideSql, physical, same, requireInstallationFileWritesOwner }),
  ]);
  const readInstallationFileSaveScope: InstallationFileCustody['readInstallationFileSaveScope'] = (
    ...args
  ) => saveScope.readInstallationFileSaveScope(saveScopeKey, ...args);
  const readOriginalDocumentFileSave: InstallationFileCustody['readOriginalDocumentFileSave'] = (
    ...args
  ) => saveScope.readOriginalDocumentFileSave(saveScopeKey, ...args);
  const readOriginalDocumentFileSaveIdentity: InstallationFileCustody['readOriginalDocumentFileSaveIdentity'] =
    (...args) => saveScope.readOriginalDocumentFileSaveIdentity(saveScopeKey, ...args);
  const readOriginalDocumentFileSaveCurrent: InstallationFileCustody['readOriginalDocumentFileSaveCurrent'] =
    (...args) => saveScope.readOriginalDocumentFileSaveCurrent(saveScopeKey, ...args);
  const requireOriginalDocumentFileSaveCompleted: InstallationFileCustody['requireOriginalDocumentFileSaveCompleted'] =
    (...args) => saveScope.requireOriginalDocumentFileSaveCompleted(saveScopeKey, ...args);
  const requireInstallationFileSaveCurrent: InstallationFileCustody['requireInstallationFileSaveCurrent'] =
    (...args) => saveScope.requireInstallationFileSaveCurrent(saveScopeKey, ...args);
  const checkInstallationFileSaveScope: InstallationFileCustody['checkInstallationFileSaveScope'] =
    (...args) => saveScope.checkInstallationFileSaveScope(saveScopeKey, ...args);
  const markInstallationFileSaveReplaced: InstallationFileCustody['markInstallationFileSaveReplaced'] =
    (...args) => saveScope.markInstallationFileSaveReplaced(saveScopeKey, ...args);
  const checkInstallationFileSaveCleanup: InstallationFileCustody['checkInstallationFileSaveCleanup'] =
    (...args) => saveScope.checkInstallationFileSaveCleanup(saveScopeKey, ...args);

  /** Own installation file writers, mutation admission and child shutdown custody. */
  return Object.freeze({
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
    requireInstallationFileWritesOwner,
    requireInstallationFileWritesAdmission,
    requireInstallationFileRoomWriter,
    requireInstallationHttpFileWriter,
    readInstallationHttpFileWrites,
    readInstallationFileRoomWrites,
    requireInstallationFileWriteAssembly,
    createInstallationOriginalRoomDownstream,
    readInstallationOriginalRoomEmitter,
    createInstallationOriginalCheckboxWriter,
    requireInstallationOriginalCheckboxWriter,
    createInstallationOriginalCheckboxGrantPreparation,
    requireInstallationOriginalCheckboxGrantPreparation,
    approveInstallationOriginalDocRoute,
    stopInstallationOriginalCheckboxWriter,
    runInstallationFileSave,
    stopInstallationFileWrites,
    readInstallationFileSaveScope,
    readOriginalDocumentFileSave,
    readOriginalDocumentFileSaveIdentity,
    readOriginalDocumentFileSaveCurrent,
    requireOriginalDocumentFileSaveCompleted,
    requireInstallationFileSaveCurrent,
    checkInstallationFileSaveScope,
    markInstallationFileSaveReplaced,
    checkInstallationFileSaveCleanup,
  });
}
