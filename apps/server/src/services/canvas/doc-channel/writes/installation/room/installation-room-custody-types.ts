import type { RoomService } from '../../../../../rooms/room-service.js';
import type { RoomTurnRequest } from '../../../../../rooms/room-turn-port.js';
import type { RoomWorktreeManager } from '../../../../../rooms/repo/room-worktree-manager.js';
import type { RoomStore } from '../../../../../rooms/room-store.js';
import type { Db } from '@dorkos/db';
import type { DocChannelStore } from '../../../store.js';
import type { RoomMergeService } from '../../../../../rooms/repo/room-merge-service.js';
import type { RoomRepoReconciler } from '../../../../../rooms/repo/room-repo-reconciler.js';
import type {
  readOwnedRoomRepoSource,
  RoomRepoStore,
} from '../../../../../rooms/repo/room-repo-store.js';
import type { RoomRepoMutex } from '../../../../../rooms/repo/room-repo-mutex.js';
import type { InstallationFileWrites } from '../../installation-file-writes.js';
import type { OwnedMutation } from '../../installation-mutations.js';
import type { CanonicalFileIdentity, CanonicalWriteLease } from '../../canonical-writer.js';
import type { InstallationRoomWrites } from '../../installation-room-writes.js';
/** Original constructor-owned assembly; a shape registers no owner. */
export interface RoomOwner {
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
/** Original active scope cells in the actual writer registry. */
export interface RoomScope {
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

/** Exact nameable original scope custody; actual instance remains root-private. */
export interface InstallationRoomScopeCustody {
  owners: WeakMap<object, RoomOwner>;
  scopes: WeakMap<object, RoomScope>;
  nativeCurrent(binding: RoomOwner, outside?: boolean): void;
  requireInstallationRoomWrites(
    writer: unknown,
    owner: InstallationFileWrites,
    db: Db,
    store: DocChannelStore,
    repos: RoomRepoStore
  ): InstallationRoomWrites;
  readInstallationRoomFileWriteOwner(
    writer: InstallationRoomWrites,
    repos: RoomRepoStore,
    mutex: RoomRepoMutex
  ): InstallationFileWrites;
  scopeOf(writer: InstallationRoomWrites, roomId: string, handle: object): RoomScope;
  readInstallationRoomSourceLease(
    writer: InstallationRoomWrites,
    roomId: string,
    handle: object
  ): Readonly<{
    repoPath: string;
    homePath: string;
    row: ReturnType<typeof readOwnedRoomRepoSource>['row'];
    identities: readonly Readonly<CanonicalFileIdentity>[];
    lease: CanonicalWriteLease;
  }>;
  within(root: string, target: string): boolean;
  checkInstallationRoomScope(
    writer: InstallationRoomWrites,
    roomId: string,
    handle: object
  ): Promise<void>;
  requireInstallationRoomNamespaceCurrent(
    writer: InstallationRoomWrites,
    roomId: string,
    handle: object
  ): undefined;
  withRecognizedInstallationRoomFiles<T>(
    writer: InstallationRoomWrites,
    roomId: string,
    paths: readonly string[],
    work: (scope: object) => Promise<T>
  ): Promise<T>;
  withRecognizedInstallationRoomNamespace<T>(
    writer: InstallationRoomWrites,
    roomId: string,
    work: (scope: object) => Promise<T>
  ): Promise<T>;
  withRecognizedInstallationRoomFileEditor<T>(
    writer: InstallationRoomWrites,
    roomId: string,
    work: (scope: object) => Promise<T>
  ): Promise<T>;
  withRecognizedInstallationRoomRepo<T>(
    writer: InstallationRoomWrites,
    roomId: string,
    work: (scope: object) => Promise<T>
  ): Promise<T>;
  withRecognizedInstallationRoomMerge<T>(
    writer: InstallationRoomWrites,
    roomId: string,
    work: (scope: object) => Promise<T>
  ): Promise<T>;
  requireInstallationRoomStopOutside(writer: InstallationRoomWrites): void;
  stopRecognizedInstallationRoomWrites(writer: InstallationRoomWrites): Promise<void>;
}

/** Private context carries existing exclusion only; caller/domain permission remains original owning policy. */
export type InstallationRoomMutationContext = Readonly<object>;
/** Original context fields recognized only in the actual private map. */
export interface OriginalRoomMutationRecord {
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

/** Fixed original ports selected only by the inaccessible root key. */
export interface OriginalRoomMutationPorts {
  mutationContexts: WeakMap<object, OriginalRoomMutationRecord>;
  scopeOf: InstallationRoomScopeCustody['scopeOf'];
  within: InstallationRoomScopeCustody['within'];
  requireInstallationRoomNamespaceCurrent: InstallationRoomScopeCustody['requireInstallationRoomNamespaceCurrent'];
  checkInstallationRoomScope: InstallationRoomScopeCustody['checkInstallationRoomScope'];
}
