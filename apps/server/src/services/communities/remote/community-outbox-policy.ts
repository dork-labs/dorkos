/**
 * Trusted writer policy for local-agent output in persisted remote mirrors.
 *
 * @module services/communities/remote/community-outbox-policy
 */
import { ulid } from 'ulidx';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import { RoomError } from '../../rooms/room-errors.js';
import type {
  PreparedMirrorWrite,
  RoomMirrorWritePolicy,
} from '../../rooms/service/room-service-deps.js';
import type { CommunityAgentEnrollmentStore } from './agent-enrollment-store.js';
import { CommunityOutboxStore, type CommunityOutboxItem } from './community-outbox-store.js';
import { RemoteMirrorStore } from './mirror-store.js';

/** Maximum unsent delivery records that one connected community may hold. */
export const COMMUNITY_OUTBOX_PER_COMMUNITY_LIMIT = 100;
/** Maximum unsent delivery records that one installation may hold. */
export const COMMUNITY_OUTBOX_INSTALL_LIMIT = 1_000;
/** An agent output that cannot be delivered within five minutes expires locally. */
export const COMMUNITY_OUTBOX_EXPIRY_MS = 5 * 60_000;

/**
 * Builds an outbox insert from server-owned mirror and enrollment records.
 *
 * There is no caller flag here. An ordinary room answers `null`, while a local
 * agent with a current enrolled remote principal gets one row inserted in the
 * exact transaction that inserts the room entry.
 */
export class CommunityOutboxPolicy implements RoomMirrorWritePolicy {
  constructor(
    private readonly mirrors: RemoteMirrorStore,
    private readonly enrollments: CommunityAgentEnrollmentStore,
    private readonly authors: AuthorRegistry,
    private readonly outbox: CommunityOutboxStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Prepare one atomic delivery row, or leave a non-mirror/non-agent post local. */
  prepare(
    room: Parameters<RoomMirrorWritePolicy['prepare']>[0],
    authorId: string,
    delivery: Parameters<RoomMirrorWritePolicy['prepare']>[2]
  ): PreparedMirrorWrite | null {
    const address = this.mirrors.outboundAddress(room.id);
    if (!address) return null;
    const author = this.authors.getById(authorId);
    const localAgentId = author?.kind === 'agent' ? author.mintedForManifestId : null;
    if (!localAgentId) return null;
    if (!this.mirrors.isActivelyAuthorized(room.id, address.ownerAuthorId)) return null;
    if (
      !this.enrollments.findRemoteMember(address.communityRef, localAgentId, address.ownerAuthorId)
    ) {
      return null;
    }
    if (
      this.outbox.pendingCount(address.communityRef) >= COMMUNITY_OUTBOX_PER_COMMUNITY_LIMIT ||
      this.outbox.pendingCount() >= COMMUNITY_OUTBOX_INSTALL_LIMIT
    ) {
      throw new RoomError(
        'COMMUNITY_OUTBOX_FULL',
        'Remote delivery is busy. Wait for pending agent messages to finish sending.'
      );
    }

    const createdAt = new Date(this.now()).toISOString();
    const row: Omit<CommunityOutboxItem, 'localEntryId'> = {
      id: ulid(),
      communityRef: address.communityRef,
      remoteRoomId: address.remoteRoomId,
      ownerAuthorId: address.ownerAuthorId,
      localAgentId,
      localParentEntryId: delivery.parentEntryId,
      attachmentIds: JSON.stringify(delivery.attachmentIds),
      idempotencyKey: ulid(),
      state: 'pending',
      createdAt,
      expiresAt: new Date(this.now() + COMMUNITY_OUTBOX_EXPIRY_MS).toISOString(),
      remoteEntryId: null,
      failure: null,
      attempts: 0,
      nextAttemptAt: createdAt,
    };
    return {
      enqueue: (entryId, tx) => this.outbox.enqueue({ ...row, localEntryId: entryId }, tx),
    };
  }
}
