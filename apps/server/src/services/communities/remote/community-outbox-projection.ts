/**
 * Owner-safe pending and failed remote-delivery projection.
 *
 * @module services/communities/remote/community-outbox-projection
 */
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import type { AttachmentRowStore } from '../../rooms/attachments/attachment-row-store.js';
import type { RoomStore } from '../../rooms/room-store.js';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { CommunityOutboxStore, type CommunityOutboxState } from './community-outbox-store.js';
import { RemoteMirrorStore } from './mirror-store.js';

/** A local delivery state the connected owner may render beside remote history. */
export interface CommunityOutboxDeliveryView {
  communityRef: CommunityRef;
  idempotencyKey: string;
  remoteRoomId: string;
  author: { displayName: string; kind: 'agent' };
  text: string;
  parentEntryId: string | null;
  attachments: readonly { id: string; name: string; mimeType: string; size: number }[];
  state: Extract<CommunityOutboxState, 'pending' | 'failed'>;
  failure: string | null;
}

/** Projects only an owner's still-unconfirmed agent output, without local file paths or secrets. */
export class CommunityOutboxProjection {
  constructor(
    private readonly outbox: CommunityOutboxStore,
    private readonly mirrors: RemoteMirrorStore,
    private readonly entries: RoomStore,
    private readonly attachments: AttachmentRowStore,
    private readonly authors: AuthorRegistry
  ) {}

  /** Resolve a receipt's durable owner-qualified retry identity without exposing local row data. */
  originForRemoteEntry(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    remoteEntryId: string
  ): string | null {
    return this.outbox.originForRemoteEntry(
      communityRef,
      remoteRoomId,
      ownerAuthorId,
      remoteEntryId
    );
  }

  /** Snapshot pending and failed entries for one owner, skipping rows whose local cache was purged. */
  list(ownerAuthorId: string): readonly CommunityOutboxDeliveryView[] {
    return this.outbox.visibleForOwner(ownerAuthorId).flatMap((item) => {
      const localRoomId = this.mirrors.localRoomIdForOwner(
        item.communityRef,
        item.remoteRoomId,
        ownerAuthorId
      );
      if (!localRoomId || item.state === 'stopped' || item.state === 'confirmed') return [];
      const entry = this.entries.getEntryById(localRoomId, item.localEntryId);
      const author = entry ? this.authors.getById(entry.authorId) : null;
      if (!entry || author?.kind !== 'agent') return [];
      return [
        {
          idempotencyKey: item.idempotencyKey,
          communityRef: item.communityRef,
          remoteRoomId: item.remoteRoomId,
          author: { displayName: author.displayName, kind: 'agent' },
          text: entry.body.text,
          parentEntryId: item.localParentEntryId
            ? this.mirrors.remoteEntryIdForLocal(localRoomId, item.localParentEntryId)
            : null,
          attachments: this.attachments.listForEntry(localRoomId, entry.id).map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
          })),
          state: item.state,
          failure: item.failure,
        },
      ];
    });
  }
}
