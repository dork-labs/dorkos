import {
  DocChannelDownstream,
  type DocDownstreamAuthority,
  requireOriginalDownstreamRoomEmitterOwner,
} from '../downstream/service.js';
import type { OriginalDownstreamRoomEmitter } from '../downstream/native-room-emitter.js';
/** One fixed owning installation gate, canonical coordinator and same-Db fence. */
import { realpath, stat } from 'node:fs/promises';
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
  type OwnedMutation,
} from './installation-mutations.js';
import { MutationRefusal, type TrustedTreeRoot, type TreeRootIdentity } from './mutation-roots.js';
import {
  CanonicalFileWriteCoordinator,
  withRecognizedCanonicalFiles,
  stopRecognizedCanonicalWriter,
  CanonicalFileIdentityChangedError,
  type CanonicalFileIdentity,
  type CanonicalWriteLease,
} from './canonical-writer.js';
import { CheckboxWriteFence, assertRecognizedCheckboxAdmission } from './checkbox-fence.js';
import { performNormalFileSave, type NormalFileSaveOutcome } from './normal-file-save.js';
import {
  InstallationRoomWrites,
  requireInstallationRoomWrites,
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
  requireInstallationHttpFileWrites,
  requireInstallationHttpFileStopOutside,
  stopRecognizedInstallationHttpFileWrites,
} from './installation-http-file-writes.js';
import {
  DocCheckboxWriteService,
  requireOriginalCheckboxWriterAssembly,
} from './checkbox-service.js';
import type { DocCheckboxAuthority } from './authority.js';
import { notifyServiceOriginalCheckboxCommitted, type DocChannelService } from '../service.js';
import { DOC_INGEST_LIMITS } from '../current/accounting.js';
import { approveOriginalDocRoute, type DocChannelGrants, type DocGrantResult } from '../grants.js';
import { DocRouteGrantRequestSchema, declaredRoute, grantTypes } from '../grant-policy.js';
import { requireOriginalDocGrantStore } from '../store.js';
import { matchesCanvasChannelEvent } from '@dorkos/shared/canvas-channel-schemas';
import { createOriginalDocTokenFileSourceReader } from '../tokens/token-native-file-source.js';
import {
  OriginalCheckboxGrantPreparation,
  requireOriginalCheckboxGrantPreparationAssembly,
  requireOriginalCheckboxGrantPreparationGrants,
  grantOriginalCheckboxRoute,
} from './checkbox-grant-preparation.js';

interface Assembly {
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
  saveHttp(req: Request, res: Response, input: WriteFileRequest): Promise<NormalFileSaveOutcome>;
  stop(): Promise<void>;
}
interface SaveScope {
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
  if (!info.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'NOT_A_FILE' });
  return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
}
function same(a: CanonicalFileIdentity, b: CanonicalFileIdentity): boolean {
  return a.canonicalPath === b.canonicalPath && a.device === b.device && a.inode === b.inode;
}
/** Private constructor membership and exact original dependencies; no structural certification. */
export function requireInstallationFileWritesOwner(
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
export function requireInstallationFileWritesAdmission(
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
export function requireInstallationFileRoomWriter(
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
export function requireInstallationHttpFileWriter(
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
export function readInstallationHttpFileWrites(
  owner: InstallationFileWrites,
  db: Db,
  store: DocChannelStore
): InstallationHttpFileWrites {
  requireInstallationFileWritesOwner(owner, db, store);
  return requireInstallationHttpFileWrites(owners.get(owner)!.httpFiles);
}
/** Return only this factory's actual captured original room writer, never another constructor instance. */
export function readInstallationFileRoomWrites(
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
export function requireInstallationFileWriteAssembly(
  owner: InstallationFileWrites,
  exactDb: Db,
  exactStore: DocChannelStore
): Readonly<Pick<Assembly, 'installation' | 'coordinator' | 'fence'>> {
  requireInstallationFileWritesOwner(owner, exactDb, exactStore);
  const { installation, coordinator, fence } = owners.get(owner)!;
  return Object.freeze({ installation, coordinator, fence });
}
/** Actual installation constructor creates one retained native sender; no attached child/stop callback. */
export function createInstallationOriginalRoomDownstream(
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
export function readInstallationOriginalRoomEmitter(
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
export function createInstallationOriginalCheckboxWriter(
  owner: InstallationFileWrites,
  db: Db,
  store: DocChannelStore,
  authority: DocCheckboxAuthority,
  service: DocChannelService
): DocCheckboxWriteService {
  requireInstallationFileWritesAdmission(owner, db, store);
  const assembly = owners.get(owner)!;
  if (assembly.checkboxConstruction) throw new Error('Owning checkbox writer already constructed.');
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
    const captured = requireOriginalCheckboxWriterAssembly(writer, db, store, assembly.coordinator);
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
export function requireInstallationOriginalCheckboxWriter(
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
export function createInstallationOriginalCheckboxGrantPreparation(
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
export function requireInstallationOriginalCheckboxGrantPreparation(
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
export function approveInstallationOriginalDocRoute(
  owner: InstallationFileWrites,
  grants: DocChannelGrants,
  raw: unknown,
  actor: import('../authorization.js').DocChannelActor,
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
export function stopInstallationOriginalCheckboxWriter(
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
export function runInstallationFileSave(
  owner: InstallationFileWrites,
  exactDb: Db,
  exactStore: DocChannelStore,
  req: Request,
  res: Response,
  input: WriteFileRequest
): Promise<NormalFileSaveOutcome> {
  requireInstallationFileWritesOwner(owner, exactDb, exactStore);
  return owners.get(owner)!.saveHttp(req, res, input);
}
/** Stop the original installation and drain its captured child lifetimes. */
export function stopInstallationFileWrites(
  owner: InstallationFileWrites,
  exactDb: Db,
  exactStore: DocChannelStore
): Promise<void> {
  requireInstallationFileWritesOwner(owner, exactDb, exactStore);
  return owners.get(owner)!.stop();
}
function scopeOf(handle: object): SaveScope {
  const scope = scopes.get(handle);
  if (!scope?.active) throw new Error('Inactive owning file-save operation.');
  outsideSql(scope.assembly.db);
  scope.owned.assertActive();
  return scope;
}
/** Detached finite arguments only; access requires an actually active private operation. */
export function readInstallationFileSaveScope(handle: object): Readonly<{
  input: Readonly<WriteFileRequest>;
  identity: Readonly<CanonicalFileIdentity>;
  lease: CanonicalWriteLease;
  forceConflict: boolean;
}> {
  const scope = scopeOf(handle);
  return Object.freeze({
    input: scope.input,
    identity: Object.freeze({ ...scope.identity }),
    lease: scope.lease,
    forceConflict: scope.forceConflict,
  });
}
/** Read actual private save custody outside SQL; no caller can create this handle. */
export function readOriginalDocumentFileSave(handle: object, db: Db, store: DocChannelStore) {
  const scope = scopeOf(handle);
  requireInstallationFileWritesOwner(scope.owner, db, store);
  if (scope.assembly.db !== db || scope.assembly.store !== store || !scope.input.documentSave)
    throw new Error('Foreign document-bound save scope.');
  return Object.freeze({ input: scope.input, identity: Object.freeze({ ...scope.identity }) });
}
/** Retain only the request identity for the same original service store. */
export function readOriginalDocumentFileSaveIdentity(handle: object, store: DocChannelStore) {
  const scope = scopeOf(handle);
  if (scope.assembly.store !== store || !scope.input.documentSave)
    throw new Error('Foreign document save request.');
  requireInstallationFileWritesOwner(scope.owner, scope.assembly.db, store);
  return scope.input.documentSave;
}
/** Read only the active original save identity inside the final document inspection transaction. */
export function readOriginalDocumentFileSaveCurrent(
  handle: object,
  db: Db,
  store: DocChannelStore
) {
  const scope = scopes.get(handle);
  if (
    !scope?.active ||
    scope.assembly.db !== db ||
    scope.assembly.store !== store ||
    !scope.input.documentSave
  )
    throw new Error('Document save has no active original scope.');
  requireInstallationFileWritesOwner(scope.owner, db, store);
  return Object.freeze({ request: scope.input.documentSave, path: scope.identity.canonicalPath });
}
/** Verify the actual original changed result inside the exact completion transaction. */
export function requireOriginalDocumentFileSaveCompleted(
  handle: object,
  db: Db,
  store: DocChannelStore,
  hash: string
): void {
  const scope = scopes.get(handle);
  if (
    !scope?.active ||
    scope.assembly.db !== db ||
    scope.assembly.store !== store ||
    scope.completedSave?.effect !== 'changed' ||
    scope.completedSave.hash !== hash
  )
    throw new Error('Document save has no original changed completion.');
  requireInstallationFileWritesOwner(scope.owner, db, store);
}

/** Final synchronous current checks directly precede each participating effect. */
export function requireInstallationFileSaveCurrent(handle: object): undefined {
  const scope = scopeOf(handle);
  if (getBoundary() !== scope.assembly.root) throw new Error('Installed file boundary changed.');
  requireDocHttpFileWriteCurrent(scope.owner, scope.caller);
  assertRecognizedCheckboxAdmission(
    scope.assembly.fence,
    scope.assembly.db,
    scope.assembly.store,
    scope.identity
  );
  return undefined;
}
/** Awaited roots/path/identity work never replaces the final synchronous current checks. */
export async function checkInstallationFileSaveScope(handle: object): Promise<void> {
  const scope = scopeOf(handle);
  await scope.owned.assertCurrentRoots();
  scopeOf(handle);
  const { resolved } = await resolveWithinCwd(scope.input.cwd, scope.input.path);
  scopeOf(handle);
  const current = await physical(scope.assembly.db, resolved);
  scopeOf(handle);
  if (!same(current, scope.identity)) throw new CanonicalFileIdentityChangedError();
  requireInstallationFileSaveCurrent(handle);
}
/** Only this operation's already reserved replacement may become its expected target. */
export function markInstallationFileSaveReplaced(
  handle: object,
  replacement: CanonicalFileIdentity
): undefined {
  const scope = scopeOf(handle);
  if (!scope.replacements.has(replacement)) throw new Error('Unknown replacement reservation.');
  if (replacement.canonicalPath === scope.identity.canonicalPath)
    throw new Error('Replacement must originate from a distinct owned temporary path.');
  scope.identity = { ...replacement, canonicalPath: scope.identity.canonicalPath };
  return undefined;
}
/** Mandatory owned-temp cleanup has exclusion/lifetime, not a fresh caller permission grant. */
export async function checkInstallationFileSaveCleanup(handle: object): Promise<void> {
  const scope = scopeOf(handle);
  await scope.owned.assertCurrentRoots();
  scopeOf(handle);
}

/** Own installation file writers, mutation admission and child shutdown custody. */
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
