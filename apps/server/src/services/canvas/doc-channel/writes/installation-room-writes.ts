import { checkOriginalHttpRoomSessionPlacement } from '../http-composition.js';
/** Internal original room exclusion/data ownership; this never grants document or editor permission. */
import { readOriginalRoomRunnerLaunch } from '../../../rooms/room-turn-runner.js';
import { readOriginalRoomTriggerLaunch } from '../../../rooms/room-trigger.js';
import {
  readRoomServiceOriginalFileRequest,
  type RoomService,
} from '../../../rooms/room-service.js';
import type { RoomTurnRequest } from '../../../rooms/room-turn-port.js';
import type { RoomWorktreeManager } from '../../../rooms/repo/room-worktree-manager.js';
import { requireOriginalHttpRoomWorktreeOwner } from '../http-composition.js';
import { readOriginalRoomPlacementFacts } from '../../../rooms/service/room-core.js';
import type { RoomStore } from '../../../rooms/room-store.js';
import { realpath } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { Db } from '@dorkos/db';
import type { DocChannelStore } from '../store.js';
import {
  readDocHttpRoomRepoCaller,
  requireDocHttpRoomRepoCaller,
  checkDocHttpRoomRepoCaller,
  requireDocHttpRoomFileWriteCurrent,
  checkDocHttpRoomFileWriteCurrent,
} from '../http-composition.js';
import {
  requireOriginalRoomNativeMergeCurrent,
  type RoomMergeService,
} from '../../../rooms/repo/room-merge-service.js';
import { readRoomRepoConfig } from '../../../rooms/repo/room-repo-config.js';
import {
  readOriginalRoomRepoMaintenanceSource,
  type RoomRepoReconciler,
} from '../../../rooms/repo/room-repo-reconciler.js';
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
  requireInstallationFileWritesOwner,
  requireInstallationFileWriteAssembly,
  requireInstallationFileWritesAdmission,
  requireInstallationFileRoomWriter,
  type InstallationFileWrites,
} from './installation-file-writes.js';
import {
  withRecognizedInstallationMutation,
  type OwnedMutation,
} from './installation-mutations.js';
import {
  withRecognizedCanonicalFiles,
  type CanonicalFileIdentity,
  type CanonicalWriteLease,
} from './canonical-writer.js';
import { hasRecognizedCheckboxUnresolved, CheckboxWriteFencedError } from './checkbox-fence.js';

interface RoomOwner {
  writer: InstallationRoomWrites;
  owner: InstallationFileWrites;
  db: Db;
  store: DocChannelStore;
  repos: RoomRepoStore;
  mutex: RoomRepoMutex;
  native: Db['$client'];
  files<T>(
    roomId: string,
    paths: readonly string[],
    work: (scope: object) => Promise<T>
  ): Promise<T>;
  namespace<T>(
    roomId: string,
    work: (scope: object) => Promise<T>,
    kind?: 'file-editor' | 'repo' | 'merge'
  ): Promise<T>;
  stop(): Promise<void>;
  requireStopOutside(): void;
}
interface RoomScope {
  writer: InstallationRoomWrites;
  binding: RoomOwner;
  roomId: string;
  roomLease: object;
  owned: OwnedMutation;
  source: ReturnType<typeof readOwnedRoomRepoSource>;
  identities: readonly CanonicalFileIdentity[];
  lease?: CanonicalWriteLease;
  active: boolean;
}
const owners = new WeakMap<object, RoomOwner>();
const scopes = new WeakMap<object, RoomScope>();
function nativeCurrent(binding: RoomOwner, outside = true): void {
  requireInstallationFileWritesOwner(binding.owner, binding.db, binding.store);
  requireInstallationFileRoomWriter(
    binding.owner,
    binding.db,
    binding.store,
    binding.repos,
    binding.writer
  );
  if (binding.db.$client !== binding.native || !binding.native.open)
    throw new Error('Room native connection changed or closed.');
  if (outside && binding.native.inTransaction)
    throw new Error('Room filesystem observation cannot await inside SQL.');
}
/** Require the installation Room writer's exact original assembly. */
export function requireInstallationRoomWrites(
  writer: unknown,
  owner: InstallationFileWrites,
  db: Db,
  store: DocChannelStore,
  repos: RoomRepoStore
): InstallationRoomWrites {
  const binding = writer && typeof writer === 'object' ? owners.get(writer) : undefined;
  if (
    !binding ||
    binding.owner !== owner ||
    binding.db !== db ||
    binding.store !== store ||
    binding.repos !== repos
  )
    throw new Error('Unknown original owning room writer.');
  nativeCurrent(binding, false);
  return writer as InstallationRoomWrites;
}
/** Exact captured assembly recognition; this returns ownership, never caller permission. */
export function readInstallationRoomFileWriteOwner(
  writer: InstallationRoomWrites,
  repos: RoomRepoStore,
  mutex: RoomRepoMutex
): InstallationFileWrites {
  const binding = owners.get(writer);
  if (!binding || binding.repos !== repos || binding.mutex !== mutex)
    throw new Error('Unknown original room file assembly.');
  nativeCurrent(binding);
  requireRoomRepoStoreDatabase(repos, binding.db);
  requireRoomRepoMutex(mutex);
  nativeCurrent(binding);
  return binding.owner;
}
function scopeOf(writer: InstallationRoomWrites, roomId: string, handle: object): RoomScope {
  const scope = scopes.get(handle);
  if (
    !scope?.active ||
    scope.writer !== writer ||
    scope.roomId !== roomId ||
    owners.get(writer) !== scope.binding
  )
    throw new Error('Unknown or retired room mutation scope.');
  nativeCurrent(scope.binding, false);
  requireRoomRepoMutationLease(scope.binding.mutex, roomId, scope.roomLease);
  scope.owned.assertActive();
  return scope;
}
/** Pure lease/root data recognition can run inside the original A's already-verified native transaction.
 * No query or FS await occurs here. Current rows/grants/editor rights still belong to original A. */
export function readInstallationRoomSourceLease(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object
): Readonly<{
  repoPath: string;
  homePath: string;
  row: ReturnType<typeof readOwnedRoomRepoSource>['row'];
  identities: readonly Readonly<CanonicalFileIdentity>[];
  lease: CanonicalWriteLease;
}> {
  const scope = scopeOf(writer, roomId, handle);
  if (scope.owned.mode !== 'files' || !scope.source.row || !scope.lease)
    throw new Error('No active room file source lease.');
  return Object.freeze({
    repoPath: scope.source.repo,
    homePath: scope.source.home,
    row: scope.source.row,
    identities: Object.freeze(scope.identities.map((identity) => Object.freeze({ ...identity }))),
    lease: scope.lease,
  });
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Awaited source observations are exclusively outside SQL and guarded again after every wait. */
export async function checkInstallationRoomScope(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object
): Promise<void> {
  let scope = scopeOf(writer, roomId, handle);
  nativeCurrent(scope.binding);
  await scope.owned.assertCurrentRoots();
  scope = scopeOf(writer, roomId, handle);
  nativeCurrent(scope.binding);
  const fresh = readOwnedRoomRepoSource(scope.binding.repos, scope.binding.db, roomId);
  scopeOf(writer, roomId, handle);
  if (
    fresh.root !== scope.source.root ||
    fresh.home !== scope.source.home ||
    fresh.repo !== scope.source.repo
  )
    throw new Error('Owning room source root changed.');
  if (scope.owned.mode === 'files') {
    if (!fresh.row || JSON.stringify(fresh.row) !== JSON.stringify(scope.source.row))
      throw new Error('Owning room repository row changed.');
    const home = await realpath(fresh.home);
    scope = scopeOf(writer, roomId, handle);
    nativeCurrent(scope.binding);
    const repo = await realpath(fresh.repo);
    scope = scopeOf(writer, roomId, handle);
    nativeCurrent(scope.binding);
    if (
      !within(scope.owned.roots[0]!.canonicalPath, home) ||
      !within(home, repo) ||
      scope.identities.some((identity) => !within(repo, identity.canonicalPath))
    )
      throw new Error('Room file source escaped its actual owning home/repository.');
  } else {
    const assembly = requireInstallationFileWriteAssembly(
      scope.binding.owner,
      scope.binding.db,
      scope.binding.store
    );
    if (hasRecognizedCheckboxUnresolved(assembly.fence, scope.binding.db, scope.binding.store))
      throw new CheckboxWriteFencedError();
  }
  scopeOf(writer, roomId, handle);
  nativeCurrent(scope.binding);
}
/** Opaque low-level effects/rollback/cleanup must call this last synchronous guard after check(). */
export function requireInstallationRoomNamespaceCurrent(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object
): undefined {
  const scope = scopeOf(writer, roomId, handle);
  nativeCurrent(scope.binding);
  if (scope.owned.mode !== 'opaque') throw new Error('No active room namespace lease.');
  const assembly = requireInstallationFileWriteAssembly(
    scope.binding.owner,
    scope.binding.db,
    scope.binding.store
  );
  if (hasRecognizedCheckboxUnresolved(assembly.fence, scope.binding.db, scope.binding.store))
    throw new CheckboxWriteFencedError();
  scopeOf(writer, roomId, handle);
  nativeCurrent(scope.binding);
  return undefined;
}
/** Private context carries existing exclusion only; caller/domain permission remains original owning policy. */
export type InstallationRoomMutationContext = Readonly<object>;
const mutationContexts = new WeakMap<
  object,
  {
    writer: InstallationRoomWrites;
    roomId: string;
    handle: object;
    maintenance?: { reconciler: RoomRepoReconciler; operation: object };
    httpCaller?: object;
    repoCaller?: object;
    nativeMerge?: { service: RoomMergeService; operation: object };
    placement?: { token: object; store: RoomStore; facts: string };
    launch?: {
      request: RoomTurnRequest;
      manager: RoomWorktreeManager;
      rooms: RoomService;
      store: RoomStore;
      facts: string;
      sessionId: string;
    };
  }
>();
/** Read the original installation Room mutation context. */
export function readInstallationRoomMutationContext(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object
): InstallationRoomMutationContext {
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle });
  return context;
}
/** HTTP variant binds the actual original private caller; no supplied checker or actor DTO. */
export function readInstallationRoomHttpMutationContext(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  httpCaller: object
): InstallationRoomMutationContext {
  const scope = scopeOf(writer, roomId, handle);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  requireDocHttpRoomFileWriteCurrent(scope.binding.owner, roomId, httpCaller);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle, httpCaller });
  return context;
}
/** Repo variant consumes only a real captured service/request operation; this is still exclusion/data. */
export function readInstallationRoomRepoMutationContext(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  service:
    | import('../../../rooms/repo/room-repo-service.js').RoomRepoService
    | import('../../../rooms/repo/room-merge-service.js').RoomMergeService,
  operation: 'enable' | 'repair' | 'merge',
  repoCaller: object
): InstallationRoomMutationContext {
  const scope = scopeOf(writer, roomId, handle);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const caller = readDocHttpRoomRepoCaller(scope.binding.owner, service, repoCaller, operation);
  if (caller.roomId !== roomId) throw new Error('Room repo request belongs to another room.');
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle, repoCaller });
  return context;
}
/** Native variant requires a fixed original Merge operation; the context grants only exclusion/data. */
export function readInstallationRoomNativeMergeMutationContext(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  service: RoomMergeService,
  operation: object
): InstallationRoomMutationContext {
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  requireOriginalRoomNativeMergeCurrent(service, operation, roomId);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle, nativeMerge: { service, operation } });
  return context;
}
/** Original dispatcher placement proof is separate from exclusion/data; no caller-owned checker. */
export function readInstallationRoomPlacementMutationContext(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  placement: object,
  store: RoomStore
): InstallationRoomMutationContext {
  const scope = scopeOf(writer, roomId, handle);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const facts = readOriginalRoomPlacementFacts(placement, scope.binding.db, store);
  if (!facts || facts.roomId !== roomId || scope.source.row?.mode !== 'owned')
    throw new Error('Room placement lost its original construction/current facts.');
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, {
    writer,
    roomId,
    handle,
    placement: { token: placement, store, facts: JSON.stringify(facts) },
  });
  return context;
}
/** Genuine original Runner launch is a separate permission origin; the scope still supplies exclusion/data only. */
export function readInstallationRoomLaunchMutationContext(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  request: RoomTurnRequest,
  manager: RoomWorktreeManager,
  rooms: RoomService,
  store: RoomStore
): InstallationRoomMutationContext {
  const scope = scopeOf(writer, roomId, handle);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const launch = readOriginalRoomRunnerLaunch(request);
  const input = launch && readOriginalRoomTriggerLaunch(request, launch.runner);
  const facts =
    launch &&
    readRoomServiceOriginalFileRequest(rooms, scope.binding.db, store, request, launch.runner);
  if (
    !launch ||
    !input ||
    !facts ||
    input.manager !== manager ||
    input.roomId !== roomId ||
    facts.roomId !== roomId ||
    scope.source.row?.mode !== 'owned'
  )
    throw new Error('Room launch lacks its original owning request/native source.');
  requireOriginalHttpRoomWorktreeOwner(scope.binding.owner, manager, scope.binding.db, rooms);
  const context = Object.freeze({});
  mutationContexts.set(context, {
    writer,
    roomId,
    handle,
    launch: {
      request,
      manager,
      rooms,
      store,
      facts: JSON.stringify(facts),
      sessionId: launch.sessionId,
    },
  });
  contextOf(context);
  return context;
}
/** Original internal maintenance origin is constructor/HTTP bound, not user permission. */
export function readInstallationRoomMaintenanceMutationContext(
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  reconciler: RoomRepoReconciler,
  operation: object
): InstallationRoomMutationContext {
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  readOriginalRoomRepoMaintenanceSource(operation, reconciler, writer, roomId);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle, maintenance: { reconciler, operation } });
  return context;
}
function contextOf(context: InstallationRoomMutationContext) {
  const actual = mutationContexts.get(context);
  if (!actual) throw new Error('Unknown room mutation context.');
  if (!actual.maintenance && !readRoomRepoConfig().enabled)
    throw new RoomError(
      'ROOM_REPOS_DISABLED',
      'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
    );
  requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  if (actual.maintenance) {
    readOriginalRoomRepoMaintenanceSource(
      actual.maintenance.operation,
      actual.maintenance.reconciler,
      actual.writer,
      actual.roomId
    );
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.httpCaller) {
    const scope = scopeOf(actual.writer, actual.roomId, actual.handle);
    requireDocHttpRoomFileWriteCurrent(scope.binding.owner, actual.roomId, actual.httpCaller);
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.repoCaller) {
    requireDocHttpRoomRepoCaller(actual.repoCaller);
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.nativeMerge) {
    requireOriginalRoomNativeMergeCurrent(
      actual.nativeMerge.service,
      actual.nativeMerge.operation,
      actual.roomId
    );
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.placement) {
    const scope = scopeOf(actual.writer, actual.roomId, actual.handle);
    const facts = readOriginalRoomPlacementFacts(
      actual.placement.token,
      scope.binding.db,
      actual.placement.store
    );
    const source = readOwnedRoomRepoSource(scope.binding.repos, scope.binding.db, actual.roomId);
    if (
      !facts ||
      facts.roomId !== actual.roomId ||
      JSON.stringify(facts) !== actual.placement.facts ||
      source.row?.mode !== 'owned' ||
      JSON.stringify(source.row) !== JSON.stringify(scope.source.row)
    )
      throw new Error('Room placement is foreign, changed or retired.');
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.launch) {
    const scope = scopeOf(actual.writer, actual.roomId, actual.handle),
      origin = actual.launch;
    const launch = readOriginalRoomRunnerLaunch(origin.request);
    const input = launch && readOriginalRoomTriggerLaunch(origin.request, launch.runner);
    const facts =
      launch &&
      readRoomServiceOriginalFileRequest(
        origin.rooms,
        scope.binding.db,
        origin.store,
        origin.request,
        launch.runner
      );
    const source = readOwnedRoomRepoSource(scope.binding.repos, scope.binding.db, actual.roomId);
    if (
      !launch ||
      !input ||
      !facts ||
      launch.sessionId !== origin.sessionId ||
      input.manager !== origin.manager ||
      input.roomId !== actual.roomId ||
      JSON.stringify(facts) !== origin.facts ||
      JSON.stringify(source.row) !== JSON.stringify(scope.source.row) ||
      source.row?.mode !== 'owned'
    )
      throw new Error('Room launch original request/member/session/source changed or retired.');
    requireOriginalHttpRoomWorktreeOwner(
      scope.binding.owner,
      origin.manager,
      scope.binding.db,
      origin.rooms
    );
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  return actual;
}
/** Finite original launch target recognition. A namespace-only context supplies no retirement permission. */
export function requireInstallationRoomLaunchTarget(
  context: InstallationRoomMutationContext,
  manager: RoomWorktreeManager,
  roomId: string,
  worktree: string,
  agentPath: string
): undefined {
  const actual = contextOf(context),
    origin = actual.launch;
  const launch = origin && readOriginalRoomRunnerLaunch(origin.request);
  const input = launch && readOriginalRoomTriggerLaunch(origin!.request, launch.runner);
  if (
    !origin ||
    !input ||
    origin.manager !== manager ||
    actual.roomId !== roomId ||
    input.worktree !== worktree ||
    input.agentPath !== agentPath
  )
    throw new Error('Room retirement lacks its original captured launch target.');
  requireInstallationRoomMutationTarget(context, worktree);
  return undefined;
}
/** Read roots retained by the original installation Room mutation context. */
export function readInstallationRoomMutationRoots(
  context: InstallationRoomMutationContext
): Readonly<{ homePath: string; repoPath: string }> {
  const actual = contextOf(context),
    scope = scopeOf(actual.writer, actual.roomId, actual.handle);
  return Object.freeze({ homePath: scope.source.home, repoPath: scope.source.repo });
}
/** Read roots from the original installation Room store. */
export function readInstallationRoomStoreRoots(
  context: InstallationRoomMutationContext,
  repos: RoomRepoStore,
  db: Db
): Readonly<{ root: string; home: string; installation: string; canonicalInstallation: string }> {
  const actual = contextOf(context),
    scope = scopeOf(actual.writer, actual.roomId, actual.handle);
  if (scope.binding.repos !== repos || scope.binding.db !== db)
    throw new Error('Room Store roots require their exact original source.');
  return Object.freeze({
    root: scope.source.root,
    home: scope.source.home,
    installation: path.dirname(scope.source.root),
    canonicalInstallation: scope.owned.roots[0]!.canonicalPath,
  });
}
/** Last synchronous fence/native/lease/lexical-target guard. Existing canonical/symlink guards still apply. */
export function requireInstallationRoomMutationTarget(
  context: InstallationRoomMutationContext,
  target: string
): undefined {
  const actual = contextOf(context),
    scope = scopeOf(actual.writer, actual.roomId, actual.handle);
  if (
    typeof target !== 'string' ||
    !path.isAbsolute(target) ||
    !within(scope.source.home, path.resolve(target))
  )
    throw new Error('Room mutation target escaped the actual owning home.');
  requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  return undefined;
}
/** Check the current target of the original installation Room mutation. */
export async function checkInstallationRoomMutationTarget(
  context: InstallationRoomMutationContext,
  target: string
): Promise<void> {
  const actual = contextOf(context);
  await checkInstallationRoomScope(actual.writer, actual.roomId, actual.handle);
  if (actual.httpCaller) {
    const scope = scopeOf(actual.writer, actual.roomId, actual.handle);
    await checkDocHttpRoomFileWriteCurrent(scope.binding.owner, actual.roomId, actual.httpCaller);
  }
  if (actual.repoCaller) await checkDocHttpRoomRepoCaller(actual.repoCaller);
  if (actual.placement) await checkOriginalHttpRoomSessionPlacement(actual.placement.token);
  requireInstallationRoomMutationTarget(context, target);
}
/** Run file operations through the recognized installation Room writer. */
export function withRecognizedInstallationRoomFiles<T>(
  writer: InstallationRoomWrites,
  roomId: string,
  paths: readonly string[],
  work: (scope: object) => Promise<T>
): Promise<T> {
  const binding = owners.get(writer);
  if (!binding) throw new Error('Unknown owning room writer.');
  nativeCurrent(binding);
  return binding.files(roomId, paths, work);
}
/** Run namespace operations through the recognized installation Room writer. */
export function withRecognizedInstallationRoomNamespace<T>(
  writer: InstallationRoomWrites,
  roomId: string,
  work: (scope: object) => Promise<T>
): Promise<T> {
  const binding = owners.get(writer);
  if (!binding) throw new Error('Unknown owning room writer.');
  nativeCurrent(binding);
  return binding.namespace(roomId, work);
}
/** Closed original Editor queue flavor; no caller-selected options or policy. */
export function withRecognizedInstallationRoomFileEditor<T>(
  writer: InstallationRoomWrites,
  roomId: string,
  work: (scope: object) => Promise<T>
): Promise<T> {
  const binding = owners.get(writer);
  if (!binding) throw new Error('Unknown owning room writer.');
  nativeCurrent(binding);
  return binding.namespace(roomId, work, 'file-editor');
}
/** Original fixed RepoService queue wording; no supplied wait/error policy. */
export function withRecognizedInstallationRoomRepo<T>(
  writer: InstallationRoomWrites,
  roomId: string,
  work: (scope: object) => Promise<T>
): Promise<T> {
  const binding = owners.get(writer);
  if (!binding) throw new Error('Unknown owning room writer.');
  nativeCurrent(binding);
  return binding.namespace(roomId, work, 'repo');
}
/** Original fixed merge queue wording and full-queue refusal. */
export function withRecognizedInstallationRoomMerge<T>(
  writer: InstallationRoomWrites,
  roomId: string,
  work: (scope: object) => Promise<T>
): Promise<T> {
  const binding = owners.get(writer);
  if (!binding) throw new Error('Unknown owning room writer.');
  nativeCurrent(binding);
  return binding.namespace(roomId, work, 'merge');
}
/** Fixed staging data from the actual original installation, not caller input or permission. */
export function readInstallationRoomUploadStagingRoot(
  context: InstallationRoomMutationContext
): Readonly<{ root: string; canonicalInstallation: string }> {
  const actual = contextOf(context),
    scope = scopeOf(actual.writer, actual.roomId, actual.handle);
  return Object.freeze({
    root: path.join(path.dirname(scope.source.root), '.temp', 'room-uploads'),
    canonicalInstallation: scope.owned.roots[0]!.canonicalPath,
  });
}
/** Require installation Room writer shutdown outside an active transaction. */
export function requireInstallationRoomStopOutside(writer: InstallationRoomWrites): void {
  const binding = owners.get(writer);
  if (!binding) throw new Error('Unknown owning room writer.');
  nativeCurrent(binding);
  binding.requireStopOutside();
}
/** Stop the recognized installation Room writer through its captured lifetime. */
export function stopRecognizedInstallationRoomWrites(
  writer: InstallationRoomWrites
): Promise<void> {
  const binding = owners.get(writer);
  if (!binding) throw new Error('Unknown owning room writer.');
  nativeCurrent(binding);
  return binding.stop();
}
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
