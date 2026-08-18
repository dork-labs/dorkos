/**
 * Where a room's words go — `ConversationTarget`, implemented for a channel.
 *
 * The other half of the pair `widgets/session/model/session-target.ts` opens.
 * Both live in their host widgets so the neutral tree never learns how either
 * surface sends.
 *
 * @module widgets/room-view/model/room-target
 */
import { useMemo } from 'react';
import { useInteractionStore } from '@/layers/entities/interactions';
import {
  isRoomMember,
  newPendingId,
  roomDisplayTitle,
  usePostToRoom,
  useReplyInThread,
  type RoomWithRoster,
} from '@/layers/entities/room';
import type {
  ConversationAttachmentPort,
  ConversationDraft,
  ConversationTarget,
} from '@/layers/features/conversation';
import { useRoomAttachments } from './use-room-attachments';

/** What a room's composer is pointed at. */
export interface RoomTargetInput {
  /**
   * The room on screen, with the roster the membership answer comes from, or
   * `undefined` while it is still being read.
   *
   * Nullable because a host resolves its room with a query and cannot call a
   * hook conditionally. Nothing consumes the target in that window — a room
   * that has not arrived draws a skeleton, not a composer — so it answers
   * `canSend: false` and says so, rather than pretending.
   */
  room: RoomWithRoster | undefined;
  /**
   * The thread this composer writes into, when it is a thread panel's rather
   * than the room's own. Absent for the room's composer.
   */
  threadRootId?: string;
}

/** A room target, plus the attachment state the host also draws chips from. */
export interface RoomTarget {
  /** The target the conversation publishes. */
  target: ConversationTarget;
  /** The staged files, for the host that has to clear them after a send. */
  attachments: ReturnType<typeof useRoomAttachments>;
}

/**
 * Adapt a room to the one thing a composer needs.
 *
 * **A room has no queue, and `queue` is therefore absent rather than a function
 * that refuses.** `Conversation.Composer` draws no queue chrome at all when it
 * is undefined; a greyed-out queue button in a channel would be a control
 * explaining a feature the surface does not have.
 *
 * **`canSend` is false for an archived room**, and says why. Membership is a
 * different refusal and the host answers it before the composer is built at all
 * — a field a definite `MEMBER_NOT_FOUND` is waiting behind should not look
 * live, so the host replaces it with the rejoin line (DOR-1233).
 *
 * @param input - The room, and the thread when this is a panel's composer.
 * @returns The target, and the attachment state the host shares with it.
 */
export function useRoomTarget(input: RoomTargetInput): RoomTarget {
  const { room, threadRootId } = input;
  const post = usePostToRoom();
  const reply = useReplyInThread();
  const attachments = useRoomAttachments(room?.id ?? '');

  const isMember = room !== undefined && isRoomMember(room.members, room.viewerAuthorId);

  const port = useMemo<ConversationAttachmentPort>(
    () => ({
      staged: attachments.pendingFiles,
      add: attachments.addFiles,
      remove: attachments.removeFile,
      retry: attachments.retryFile,
      cancel: attachments.cancelUpload,
      hasFailed: attachments.hasFailedUpload,
      isUploading: attachments.isUploading,
      // Uploading IS part of a room's send — `send` awaits `uploadAndGetIds`
      // itself — so Enter never has to wait, and Escape keeps meaning the one
      // thing it means in a channel: take the `@` picker down.
      holdsSendWhileUploading: false,
    }),
    [attachments]
  );

  const target = useMemo<ConversationTarget>(
    () => ({
      kind: 'room',
      id: room?.id ?? '',
      // Already phrased for the destination, which is also the box's accessible
      // name — so "which conversation is this for?" is a question the
      // accessibility tree can answer, not just a screenshot.
      placeholder:
        room === undefined
          ? 'Message…'
          : threadRootId === undefined
            ? `Message ${roomDisplayTitle(room)}…`
            : 'Reply in this thread…',
      canSend: room !== undefined && !room.archived && isMember,
      ...(room?.archived === true
        ? { canSendReason: 'This conversation is archived. You can read it, but not add to it.' }
        : !isMember
          ? { canSendReason: 'You left this channel. You can read it, but not add to it.' }
          : {}),
      async send(draft: ConversationDraft): Promise<void> {
        if (room === undefined) throw new Error('That conversation is not loaded yet.');
        if (room.archived) throw new Error('This conversation is archived.');
        // **Posting into a room is an interaction with it** (DOR-1156). Today is
        // ordered by `max(userLastMessageAt, userLastOpenedAt)` and the client
        // half was only written by opening a row — so the home surface, which IS
        // #team and is arrived at rather than opened, could be written in all
        // morning and hold no record at all. A thread reply records the ROOM: a
        // thread reads its room's cursor, so one place has one record.
        useInteractionStore.getState().recordOpened('room', room.id);
        // Minted here, at the keystroke, because that is when the pending row
        // has to appear — before there is any server id to call it by.
        const clientId = newPendingId();
        const attachmentNames = attachments.pendingFiles.map((file) => file.file.name);
        // The batch identity, read in the same breath as the names: what this
        // send is sending, and therefore exactly what it may clear when it lands.
        const sentFileIds = attachments.pendingFiles.map((file) => file.id);
        const attachmentIds = await attachments.uploadAndGetIds();
        // Cleared only once the ids are safely in the message, and scoped to the
        // batch this send took — clearing the bar wholesale silently ate a file
        // dropped in during the upload.
        attachments.clearFiles(sentFileIds);
        // No per-call callbacks: a refusal is handled by the mutation itself,
        // which still runs when this composer is gone. See `usePostToRoom`.
        const rootId = draft.parentEntryId ?? threadRootId;
        if (rootId !== undefined) {
          reply.mutate({
            roomId: room.id,
            rootEntryId: rootId,
            text: draft.text,
            clientId,
            attachmentIds,
            attachmentNames,
          });
          return;
        }
        post.mutate({
          roomId: room.id,
          text: draft.text,
          clientId,
          attachmentIds,
          attachmentNames,
        });
      },
      // No `queue`: a room has no queue, and the composer draws no queue chrome
      // at all rather than a disabled one.
      queueDepth: 0,
      attachments: port,
    }),
    [room, threadRootId, isMember, attachments, port, post, reply]
  );

  return { target, attachments };
}
