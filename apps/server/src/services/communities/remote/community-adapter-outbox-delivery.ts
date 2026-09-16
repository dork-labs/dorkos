/**
 * Native-adapter delivery for durable local mirror output.
 *
 * @module services/communities/remote/community-adapter-outbox-delivery
 */
import { Readable } from 'node:stream';
import type { CommunityAdapter } from '@dorkos/shared/community-adapter';
import type { AttachmentRowStore } from '../../rooms/attachments/attachment-row-store.js';
import type { RoomAttachmentStore } from '../../rooms/attachments/room-attachment-store.js';
import type { RoomStore } from '../../rooms/room-store.js';
import type { CommunityAgentEnrollmentStore } from './agent-enrollment-store.js';
import type { CommunityOutboxItem, CommunityOutboxStore } from './community-outbox-store.js';
import type {
  CommunityOutboxDelivery,
  CommunityDeliveryResult,
} from './community-outbox-worker.js';
import type { RemoteMirrorStore } from './mirror-store.js';

/** The native adapter registry returns the shared ref-and-owner instance. */
export interface RemoteAdapterForDelivery {
  (
    communityRef: CommunityOutboxItem['communityRef'],
    ownerAuthorId: string
  ): CommunityAdapter | null;
}

/** Attach the receipt to the adapter's stream barrier before buffered echo is released. */
export interface ConfirmNativePostOrigin {
  (input: {
    communityRef: CommunityOutboxItem['communityRef'];
    ownerAuthorId: string;
    remoteEntryId: string;
    idempotencyKey: string;
  }): void;
}

/**
 * Sends a single committed local entry through the native adapter.
 *
 * The writer never reaches this class. Every byte is read through the bounded
 * local attachment store, every remote request gets the same stable key, and a
 * receipt is persisted before the adapter releases an echo it buffered.
 */
export class CommunityAdapterOutboxDelivery implements CommunityOutboxDelivery {
  constructor(
    private readonly adapters: RemoteAdapterForDelivery,
    private readonly mirrors: RemoteMirrorStore,
    private readonly enrollments: CommunityAgentEnrollmentStore,
    private readonly entries: RoomStore,
    private readonly attachmentRows: AttachmentRowStore,
    private readonly attachments: RoomAttachmentStore,
    private readonly outbox: CommunityOutboxStore,
    private readonly confirmNativePostOrigin: ConfirmNativePostOrigin
  ) {}

  /** Upload attachments then post one agent entry, retaining its remote receipt. */
  async deliver(
    item: CommunityOutboxItem,
    stillAuthorized: () => boolean | Promise<boolean>
  ): Promise<CommunityDeliveryResult> {
    if (!(await stillAuthorized())) return { kind: 'stopped', reason: 'stopped-or-unauthorized' };
    const adapter = this.adapters(item.communityRef, item.ownerAuthorId);
    const enrollment = this.enrollments.findRemoteMember(
      item.communityRef,
      item.localAgentId,
      item.ownerAuthorId
    );
    const localRoomId = this.mirrors.localRoomIdForOwner(
      item.communityRef,
      item.remoteRoomId,
      item.ownerAuthorId
    );
    if (!adapter || !enrollment || !localRoomId)
      return { kind: 'stopped', reason: 'stopped-or-unauthorized' };
    const entry = this.entries.getEntryById(localRoomId, item.localEntryId);
    if (!entry || entry.kind !== 'post')
      return { kind: 'permanent', reason: 'local-entry-unavailable' };

    const attachmentIds = parseAttachmentIds(item.attachmentIds);
    if (!attachmentIds) return { kind: 'permanent', reason: 'invalid-local-attachments' };
    const uploaded: string[] = [];
    for (const attachmentId of attachmentIds) {
      if (!(await stillAuthorized())) return { kind: 'stopped', reason: 'stopped-or-unauthorized' };
      const attachment = this.attachmentRows.get(localRoomId, attachmentId);
      if (!attachment || attachment.entryId !== item.localEntryId) {
        return { kind: 'permanent', reason: 'local-attachment-unavailable' };
      }
      const stored = await this.attachments.get(
        localRoomId,
        attachment.id,
        attachment.extension,
        attachment.mimeType
      );
      if (!stored || stored.size !== attachment.size) {
        return { kind: 'permanent', reason: 'local-attachment-unavailable' };
      }
      try {
        const remote = await adapter.uploadAttachment(item.remoteRoomId, {
          idempotencyKey: `${item.idempotencyKey}:file:${attachment.id}`,
          name: attachment.name,
          contentType: attachment.mimeType,
          byteSize: attachment.size,
          bytes: readableBytes(stored.stream),
          actingMemberId: enrollment.remoteMemberId,
        });
        uploaded.push(remote.id);
      } catch (error) {
        return deliveryFailure(error);
      }
    }
    if (!(await stillAuthorized())) return { kind: 'stopped', reason: 'stopped-or-unauthorized' };
    const parentEntryId = item.localParentEntryId
      ? this.mirrors.remoteEntryIdForLocal(localRoomId, item.localParentEntryId)
      : null;
    if (item.localParentEntryId && !parentEntryId)
      return { kind: 'permanent', reason: 'remote-parent-unavailable' };
    try {
      const receipt = await adapter.post(item.remoteRoomId, {
        text: entry.body.text,
        ...(parentEntryId ? { parentEntryId } : {}),
        mentions: [],
        actingMemberId: enrollment.remoteMemberId,
        idempotencyKey: item.idempotencyKey,
        ...(uploaded.length > 0 ? { attachmentIds: uploaded } : {}),
      });
      this.outbox.recordOrigin({
        communityRef: item.communityRef,
        remoteRoomId: item.remoteRoomId,
        ownerAuthorId: item.ownerAuthorId,
        remoteEntryId: receipt.entryId,
        idempotencyKey: item.idempotencyKey,
      });
      this.confirmNativePostOrigin({
        communityRef: item.communityRef,
        ownerAuthorId: item.ownerAuthorId,
        remoteEntryId: receipt.entryId,
        idempotencyKey: item.idempotencyKey,
      });
      return { kind: 'confirmed', remoteEntryId: receipt.entryId };
    } catch (error) {
      return deliveryFailure(error);
    }
  }
}

/** Preserve byte streaming across the attachment and community ports. */
async function* readableBytes(stream: Readable): AsyncIterable<Uint8Array> {
  for await (const chunk of stream) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
}

/** Refuse malformed local state before a network request. */
function parseAttachmentIds(value: string): readonly string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.length <= 8 &&
      parsed.every((id) => typeof id === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Convert typed remote refusals to terminal delivery state and keep outages retryable. */
function deliveryFailure(error: unknown): CommunityDeliveryResult {
  const message = error instanceof Error ? error.message : 'remote delivery failed';
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;
  return status === 401 || status === 403 || status === 409 || status === 413 || status === 415
    ? { kind: 'permanent', reason: message }
    : { kind: 'retry', reason: message };
}
