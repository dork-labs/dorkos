/**
 * Production composition for one persisted remote-community delivery runtime.
 *
 * @module services/communities/remote/community-outbox-runtime
 */
import type { Db } from '@dorkos/db';
import type { AttachmentRowStore } from '../../rooms/attachments/attachment-row-store.js';
import type { RoomAttachmentStore } from '../../rooms/attachments/room-attachment-store.js';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import type { RoomMirrorAccess, RoomMirrorWritePolicy } from '../../rooms/room-service.js';
import type { RoomStore } from '../../rooms/room-store.js';
import {
  CommunityAdapterOutboxDelivery,
  type ConfirmNativePostOrigin,
  type RemoteAdapterForDelivery,
} from './community-adapter-outbox-delivery.js';
import { CommunityAgentEnrollmentStore } from './agent-enrollment-store.js';
import { CommunityOutboxPolicy } from './community-outbox-policy.js';
import { CommunityOutboxProjection } from './community-outbox-projection.js';
import { CommunityOutboxStore } from './community-outbox-store.js';
import {
  CommunityOutboxRunner,
  CommunityOutboxWorker,
  type CommunityOutboxChangeListener,
} from './community-outbox-worker.js';
import { RemoteMirrorStore } from './mirror-store.js';

/** Dependencies the server bootstrap already owns after constructing its one room subsystem. */
export interface CommunityOutboxRuntimeDeps {
  db: Db;
  roomStore: RoomStore;
  authors: AuthorRegistry;
  attachmentRows: AttachmentRowStore;
  attachmentBytes: RoomAttachmentStore;
  adapters: RemoteAdapterForDelivery;
  confirmNativePostOrigin: ConfirmNativePostOrigin;
  changes?: CommunityOutboxChangeListener;
  now?: () => number;
}

/**
 * One process-wide runtime for all persisted mirrors.
 *
 * It owns no second dispatcher, budget, or room service. The existing room
 * subsystem receives `mirrorAccess` and `mirrorWrites`; the remote lifecycle
 * supplies the same `mirrors`, `enrollments`, and `outbox` to its bridge.
 */
export class CommunityOutboxRuntime {
  readonly mirrors: RemoteMirrorStore;
  readonly enrollments: CommunityAgentEnrollmentStore;
  readonly outbox: CommunityOutboxStore;
  readonly mirrorWrites: RoomMirrorWritePolicy;
  readonly projection: CommunityOutboxProjection;
  private readonly authors: AuthorRegistry;
  private readonly runner: CommunityOutboxRunner;

  constructor(deps: CommunityOutboxRuntimeDeps) {
    const now = deps.now ?? (() => Date.now());
    this.authors = deps.authors;
    this.mirrors = new RemoteMirrorStore(deps.db, deps.roomStore, deps.authors);
    this.enrollments = new CommunityAgentEnrollmentStore(deps.db);
    this.outbox = new CommunityOutboxStore(deps.db);
    this.mirrorWrites = new CommunityOutboxPolicy(
      this.mirrors,
      this.enrollments,
      deps.authors,
      this.outbox,
      now
    );
    this.projection = new CommunityOutboxProjection(
      this.outbox,
      this.mirrors,
      deps.roomStore,
      deps.attachmentRows,
      deps.authors
    );
    const delivery = new CommunityAdapterOutboxDelivery(
      deps.adapters,
      this.mirrors,
      this.enrollments,
      deps.roomStore,
      deps.attachmentRows,
      deps.attachmentBytes,
      this.outbox,
      deps.confirmNativePostOrigin
    );
    const worker = new CommunityOutboxWorker(
      this.outbox,
      {
        canDeliver: (item) => {
          const localRoomId = this.mirrors.localRoomIdForOwner(
            item.communityRef,
            item.remoteRoomId,
            item.ownerAuthorId
          );
          const agentAuthorId = this.authors
            .listActive('agent')
            .find((author) => author.mintedForManifestId === item.localAgentId)?.id;
          return (
            this.outbox.isPending(item.id) &&
            localRoomId !== null &&
            agentAuthorId !== undefined &&
            this.mirrors.isActivelyAuthorized(localRoomId, item.ownerAuthorId) &&
            this.mirrors.canRead(localRoomId, agentAuthorId) === true &&
            this.enrollments.findRemoteMember(
              item.communityRef,
              item.localAgentId,
              item.ownerAuthorId
            ) !== null &&
            deps.adapters(item.communityRef, item.ownerAuthorId) !== null
          );
        },
      },
      delivery,
      now,
      deps.changes
    );
    this.runner = new CommunityOutboxRunner(worker);
  }

  /** Access control handed to the one existing RoomService at bootstrap. */
  get mirrorAccess(): RoomMirrorAccess {
    return this.mirrors;
  }

  /** Start recovery of rows left pending by a prior process before serving new work. */
  start(): void {
    this.runner.start();
  }

  /** Stop scheduling remote delivery during server shutdown. */
  stop(): void {
    this.runner.stop();
  }
}
