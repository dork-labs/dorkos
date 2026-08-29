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
  type RoomBranchStatus,
  type RoomMergeResult,
  type RoomMergeServiceDeps,
  type RoomRepoStatus,
} from './room-merge-service.js';
export { RoomRepoMutex, MAX_QUEUE_DEPTH } from './room-repo-mutex.js';
export { ROOM_MD_FILENAME, ROOM_MD_SEED_COMMIT_MESSAGE, seedRoomMd } from './room-md.js';
export { RoomConventions, ROOM_CONVENTIONS_TAG } from './room-conventions.js';
export { readRoomRepoConfig, type RoomRepoConfig } from './room-repo-config.js';
export { GitUnavailableError } from './room-repo-git.js';
export { RoomFilesService } from './room-files.js';
