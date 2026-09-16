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
  type RemoteAdapterForDelivery,
} from './community-adapter-outbox-delivery.js';
import { CommunityAgentEnrollmentStore } from './agent-enrollment-store.js';
import { CommunityOutboxPolicy } from './community-outbox-policy.js';
import { CommunityOutboxProjection } from './community-outbox-projection.js';
import { CommunityOutboxStore } from './community-outbox-store.js';
import {
  CommunityOutboxRunner,
  type CommunityOutboxRetryInput,
  type CommunityOutboxRetryResult,
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
  /** True only while this process still owns the local Mesh manifest. */
  isLocalAgentCurrent: (localAgentId: string) => boolean | Promise<boolean>;
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
  private readonly changes: CommunityOutboxChangeListener | undefined;
  private readonly isLocalAgentCurrent: (localAgentId: string) => boolean | Promise<boolean>;
  private readonly worker: CommunityOutboxWorker;
  private readonly runner: CommunityOutboxRunner;

  constructor(deps: CommunityOutboxRuntimeDeps) {
    const now = deps.now ?? (() => Date.now());
    this.authors = deps.authors;
    this.changes = deps.changes;
    this.isLocalAgentCurrent = deps.isLocalAgentCurrent;
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
    const delivery = new CommunityAdapterOutboxDelivery(
      deps.adapters,
      this.mirrors,
      this.enrollments,
      deps.roomStore,
      deps.attachmentRows,
      deps.attachmentBytes,
      this.outbox
    );
    this.worker = new CommunityOutboxWorker(
      this.outbox,
      {
        canDeliver: async (item) => {
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
            (await this.isLocalAgentCurrent(item.localAgentId)) &&
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
    this.projection = new CommunityOutboxProjection(
      this.outbox,
      this.mirrors,
      deps.roomStore,
      deps.attachmentRows,
      deps.authors,
      (id) => this.worker.isInFlight(id),
      now
    );
    this.runner = new CommunityOutboxRunner(this.worker);
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

  /** Abort only delivery currently in progress for one owner-qualified remote room. */
  abortForRoom(
    communityRef: CommunityOutboxRetryInput['communityRef'],
    remoteRoomId: string,
    ownerAuthorId: string
  ): void {
    this.worker.abortForRoom(communityRef, remoteRoomId, ownerAuthorId);
  }

  /** Abort only delivery currently in progress for one owner-qualified local agent. */
  abortForAgent(
    communityRef: CommunityOutboxRetryInput['communityRef'],
    localAgentId: string,
    ownerAuthorId: string
  ): void {
    this.worker.abortForAgent(communityRef, localAgentId, ownerAuthorId);
  }

  /** Stop and abort delivery for an unregistered local manifest before any later network boundary. */
  stopForAgent(
    communityRef: CommunityOutboxRetryInput['communityRef'],
    localAgentId: string,
    ownerAuthorId: string
  ): void {
    this.outbox.stopForAgent(communityRef, localAgentId, ownerAuthorId);
    this.worker.abortForAgent(communityRef, localAgentId, ownerAuthorId);
    this.changes?.changed(ownerAuthorId);
  }

  /** Ask this runtime's sole worker to release one genuine pending backoff immediately. */
  async retryNow(input: CommunityOutboxRetryInput): Promise<CommunityOutboxRetryResult> {
    const item = this.outbox.deliveryForOwner(
      input.communityRef,
      input.remoteRoomId,
      input.ownerAuthorId,
      input.idempotencyKey
    );
    if (!item) return 'missing';
    const localRoomId = this.mirrors.localRoomIdForOwner(
      item.communityRef,
      item.remoteRoomId,
      item.ownerAuthorId
    );
    const authorId = this.authors
      .listActive('agent')
      .find((author) => author.mintedForManifestId === item.localAgentId)?.id;
    if (
      !(await this.isLocalAgentCurrent(item.localAgentId)) ||
      !localRoomId ||
      !authorId ||
      !this.mirrors.isActivelyAuthorized(localRoomId, item.ownerAuthorId) ||
      this.mirrors.canRead(localRoomId, authorId) !== true ||
      !this.enrollments.findRemoteMember(item.communityRef, item.localAgentId, item.ownerAuthorId)
    ) {
      return 'terminal';
    }
    return this.worker.retryNow(input);
  }
}
