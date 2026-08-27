/**
 * A room's own git repo — the store, the sweep that rebuilds its cache, and the
 * service that gives a room files or takes them away (spec `project-rooms` §3).
 *
 * @module server/services/rooms/repo
 */
export {
  RoomRepoStore,
  ROOM_REPO_SIDECAR_FILENAME,
  InvalidRoomIdError,
} from './room-repo-store.js';
export { RoomRepoReconciler, type RoomRepoReconcileResult } from './room-repo-reconciler.js';
export {
  RoomRepoService,
  ROOM_REPO_EXISTS_CODE,
  type EnableRoomRepoResult,
  type RoomRepoServiceDeps,
} from './room-repo-service.js';
export { ROOM_MD_FILENAME, ROOM_MD_SEED_COMMIT_MESSAGE, seedRoomMd } from './room-md.js';
export { readRoomRepoConfig, type RoomRepoConfig } from './room-repo-config.js';
