import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '@dorkos/db';
import type { DocChannelStore } from '../../../store.js';
import {
  requireRoomRepoStoreDatabase,
  readOwnedRoomRepoSource,
  type RoomRepoStore,
} from '../../../../../rooms/repo/room-repo-store.js';
import {
  requireRoomRepoMutex,
  requireRoomRepoMutationLease,
  type RoomRepoMutex,
} from '../../../../../rooms/repo/room-repo-mutex.js';
import {
  requireInstallationFileWritesOwner,
  requireInstallationFileWriteAssembly,
  requireInstallationFileRoomWriter,
  type InstallationFileWrites,
} from '../../installation-file-writes.js';
import { type CanonicalFileIdentity, type CanonicalWriteLease } from '../../canonical-writer.js';
import { hasRecognizedCheckboxUnresolved, CheckboxWriteFencedError } from '../../checkbox-fence.js';
import type { InstallationRoomWrites } from '../../installation-room-writes.js';
import type {
  RoomOwner,
  RoomScope,
  InstallationRoomScopeCustody,
} from './installation-room-custody-types.js';
/** Allocate unrelated Room scope custody; actual instance remains original-module private. */
export function createIsolatedInstallationRoomScopeCustody(): InstallationRoomScopeCustody {
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
  function requireInstallationRoomWrites(
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
  function readInstallationRoomFileWriteOwner(
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
  function readInstallationRoomSourceLease(
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
  async function checkInstallationRoomScope(
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
  function requireInstallationRoomNamespaceCurrent(
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

  /** Run file operations through the recognized installation Room writer. */
  function withRecognizedInstallationRoomFiles<T>(
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
  function withRecognizedInstallationRoomNamespace<T>(
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
  function withRecognizedInstallationRoomFileEditor<T>(
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
  function withRecognizedInstallationRoomRepo<T>(
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
  function withRecognizedInstallationRoomMerge<T>(
    writer: InstallationRoomWrites,
    roomId: string,
    work: (scope: object) => Promise<T>
  ): Promise<T> {
    const binding = owners.get(writer);
    if (!binding) throw new Error('Unknown owning room writer.');
    nativeCurrent(binding);
    return binding.namespace(roomId, work, 'merge');
  }

  /** Require installation Room writer shutdown outside an active transaction. */
  function requireInstallationRoomStopOutside(writer: InstallationRoomWrites): void {
    const binding = owners.get(writer);
    if (!binding) throw new Error('Unknown owning room writer.');
    nativeCurrent(binding);
    binding.requireStopOutside();
  }

  /** Stop the recognized installation Room writer through its captured lifetime. */
  function stopRecognizedInstallationRoomWrites(writer: InstallationRoomWrites): Promise<void> {
    const binding = owners.get(writer);
    if (!binding) throw new Error('Unknown owning room writer.');
    nativeCurrent(binding);
    return binding.stop();
  }
  return Object.freeze({
    owners,
    scopes,
    nativeCurrent,
    requireInstallationRoomWrites,
    readInstallationRoomFileWriteOwner,
    scopeOf,
    readInstallationRoomSourceLease,
    within,
    checkInstallationRoomScope,
    requireInstallationRoomNamespaceCurrent,
    withRecognizedInstallationRoomFiles,
    withRecognizedInstallationRoomNamespace,
    withRecognizedInstallationRoomFileEditor,
    withRecognizedInstallationRoomRepo,
    withRecognizedInstallationRoomMerge,
    requireInstallationRoomStopOutside,
    stopRecognizedInstallationRoomWrites,
  });
}
