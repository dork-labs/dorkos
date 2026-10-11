import type { RoomRepoStore } from '../room-repo-store.js';
import type { RoomRepoMutex } from '../room-repo-mutex.js';
import type { Stats } from 'node:fs';
import type { Room } from '@dorkos/shared/room-schemas';
import type { RoomRepoSidecar } from '@dorkos/shared/room-repo';
import type { StrayChange } from '../room-repo-git.js';
import type { InstallationRoomMutationContext } from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import type {
  RoomRepoService,
  RoomRepoServiceDeps,
  RoomRepoOwningConstruction,
  EnableRoomRepoResult,
  RoomMainRepair,
  RoomMainRepairResult,
  RepairAction,
} from '../room-repo-service.js';

/** Exact root-private repo operation state and original private callback signatures. */
export interface RoomRepoServiceView {
  readonly operations: WeakMap<InstallationRoomMutationContext, RoomRepoServiceOperation>;
  readonly originalService: RoomRepoService;
  readonly deps: Readonly<RoomRepoServiceDeps>;
  readonly owning: RoomRepoOwningConstruction | undefined;
  readonly acquiredSeedRepos: WeakMap<
    InstallationRoomMutationContext,
    { roomId: string; home: string; homeStat: Stats; repo: string; repoStat: Stats }
  >;
  readonly requireEnabled: () => void;
  readonly sameRepoInode: (left: Stats, right: Stats) => boolean;
  readonly strayChangesCommitMessage: string;
  readonly enableUnderLock: (
    roomId: string,
    callerAuthorId: string,
    context: InstallationRoomMutationContext
  ) => Promise<EnableRoomRepoResult>;
  readonly seedGuarded: (
    roomId: string,
    room: Room,
    callerAuthorId: string,
    context: InstallationRoomMutationContext,
    publish?: RoomRepoSidecar
  ) => Promise<void>;
  readonly repoIsInitialised: (
    roomId: string,
    context?: InstallationRoomMutationContext
  ) => Promise<boolean>;
  readonly repairUnderLock: (
    roomId: string,
    repair: RoomMainRepair,
    context: InstallationRoomMutationContext
  ) => Promise<RoomMainRepairResult>;
  readonly keepStrayChanges: (
    repoDir: string,
    ceiling: string,
    strayCount: number,
    context: InstallationRoomMutationContext
  ) => Promise<RepairAction>;
  readonly discardStrayChanges: (
    repoDir: string,
    ceiling: string,
    strays: readonly StrayChange[],
    paths: readonly string[],
    context: InstallationRoomMutationContext
  ) => Promise<RepairAction>;
  readonly seedRepo: (
    roomId: string,
    room: Room,
    callerAuthorId: string,
    context: InstallationRoomMutationContext
  ) => Promise<void>;
  readonly unwindFailedEnable: (
    roomId: string,
    context: InstallationRoomMutationContext
  ) => Promise<void>;
}

/** Exact original private active repo operation row; no construction or registration authority. */
export interface RoomRepoServiceOperation {
  service: RoomRepoService;
  handle: object;
  owning: RoomRepoOwningConstruction;
  store: RoomRepoStore;
  mutex: RoomRepoMutex;
  roomId: string;
  operation: 'enable' | 'repair';
}
