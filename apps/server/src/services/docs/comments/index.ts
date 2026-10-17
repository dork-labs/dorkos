/**
 * Comments on docs (DOR-2983): the wiring, and the one instance the routes
 * and the agent tools share.
 *
 * Built once at boot ({@link wireDocComments}), before any turn can run, so
 * the waker hears every dispatch from the first one. The author registry and
 * Mesh are read at call time, since both are wired later in boot.
 *
 * @module services/docs/comments
 */
import type { Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import { resolveRoomLimits } from '../../rooms/limits/room-limits.js';
import { getRoomAuthors } from '../../rooms/index.js';
import { readOwnerAccount } from '../../core/auth/index.js';
import { configManager } from '../../core/config-manager.js';
import { postLevelFor } from '../../core/turn-power/turn-levels.js';
import { notifyDocComment } from '../../notifications/emitters/doc-comments.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { CommentDirectory } from './comment-directory.js';
import { DocCommentService } from './comment-service.js';
import { DocCommentStore } from './comment-store.js';
import { CommentWaker, type CommentWakeLimits } from './comment-wake.js';

export {
  DocCommentService,
  type CommentWriter,
  type CommentWriteResult,
} from './comment-service.js';
export { CommentDirectory, type CommentTrust } from './comment-directory.js';
export { DocCommentError, type DocCommentErrorCode } from './comment-errors.js';
export { resolveDocLocation, type DocLocation } from './doc-location.js';
export { listThreadsForAgent, createThreadOnRange } from './comment-agent-view.js';

/** The shared pieces, once wired. */
export interface DocComments {
  /** The comment service. */
  service: DocCommentService;
  /** Authors and trust, for callers that resolve who is writing. */
  directory: CommentDirectory;
  /** The waker, kept so a shutting-down server can stop it. */
  waker: CommentWaker;
}

let active: DocComments | null = null;

/** The room limits a comment chain is held to, read per call. */
function liveLimits(): CommentWakeLimits {
  const limits = resolveRoomLimits(null, configManager.get('rooms'));
  return {
    enabled: limits.turnLimitsEnabled,
    maxAgentDepth: limits.maxAgentDepth,
    maxTurnsPerAgentPerCascade: limits.maxTurnsPerAgentPerCascade,
  };
}

/**
 * Build the doc comment service and make it the shared one.
 *
 * @param deps - The database, and Mesh and the room binding port, read at call time.
 */
export function wireDocComments(deps: {
  db: Db;
  meshCore: () => MeshCore | undefined;
  roomSessionPlace: () => RoomSessionPlacePort | undefined;
}): DocComments {
  const store = new DocCommentStore(deps.db);
  const directory = new CommentDirectory({
    authors: getRoomAuthors,
    ownerUserId: () => readOwnerAccount()?.id ?? null,
    meshCore: deps.meshCore,
  });
  const waker = new CommentWaker({
    store,
    limits: liveLimits,
    turnLevelOf: (sessionId) => postLevelFor([sessionId]),
    meshCore: deps.meshCore,
    roomSessionPlace: deps.roomSessionPlace,
  });
  const service = new DocCommentService({
    store,
    directory,
    waker,
    limits: liveLimits,
    notify: notifyDocComment,
  });
  active = { service, directory, waker };
  return active;
}

/** The shared doc comments, or null before boot wired them (a hub, a unit test). */
export function getDocComments(): DocComments | null {
  return active;
}
