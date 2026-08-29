/**
 * A room's own git repo — the store, the sweep that rebuilds its cache, the
 * service that gives a room files or takes them away, and the composer that
 * puts `ROOM.md` in front of every member agent (spec `project-rooms` §3).
 *
 * @module server/services/rooms/repo
 */
export {
  RoomRepoStore,
  ROOM_REPO_SIDECAR_FILENAME,
  InvalidRoomIdError,
} from './room-repo-store.js';
export {
  RoomRepoReconciler,
  type RoomRepoReconcileResult,
  type RoomWorktreeReapTotals,
} from './room-repo-reconciler.js';
export {
  RoomWorktreeManager,
  type RoomWorktreeHandle,
  type RoomWorktreeManagerDeps,
  type RoomWorktreeStatus,
  type RoomWorktreeSweepResult,
} from './room-worktree-manager.js';
export {
  RoomRepoService,
  ROOM_REPO_EXISTS_CODE,
  type EnableRoomRepoResult,
  type RoomRepoServiceDeps,
} from './room-repo-service.js';
export {
  RoomMergeService,
  type RoomMergeResult,
  type RoomMergeServiceDeps,
} from './room-merge-service.js';
// The status shapes are declared in `@dorkos/shared/room-repo`, because the
// file explorer reads them over HTTP and a client cannot import a server module
// (spec `project-rooms` §3.9). Re-exported here so a reader inside this domain
// still finds them beside the service that computes them.
export type { RoomBranchStatus, RoomRepoStatus } from '@dorkos/shared/room-repo';
export { RoomRepoMutex, MAX_QUEUE_DEPTH } from './room-repo-mutex.js';
export { ROOM_MD_FILENAME, ROOM_MD_SEED_COMMIT_MESSAGE, seedRoomMd } from './room-md.js';
export { RoomConventions, ROOM_CONVENTIONS_TAG } from './room-conventions.js';
export { readRoomRepoConfig, type RoomRepoConfig } from './room-repo-config.js';
export { GitUnavailableError } from './room-repo-git.js';
export { RoomFilesService } from './room-files.js';
