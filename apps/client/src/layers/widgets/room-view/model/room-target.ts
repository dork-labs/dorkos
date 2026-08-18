/**
 * Where a room's words go — `ConversationTarget`, implemented for a channel.
 *
 * The other half of the pair `widgets/session/model/session-target.ts` opens.
 * Both live in their host widgets so the neutral tree never learns how either
 * surface sends.
 *
 * @module widgets/room-view/model/room-target
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
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

  /**
   * What the port's actions and `send` read at the moment they RUN.
   *
   * The target is the conversation's context value, so anything that churns its
   * identity re-renders the entire transcript — once per streamed token, which
   * is exactly what virtualizing the list was for. Three of this hook's inputs
   * churn by construction: `useRoomAttachments` returns a fresh literal every
   * render, and each `useMutation` mints a fresh result object. None of them is
   * read while rendering, so they are read from here when somebody presses
   * Enter instead, and the memos below depend only on facts that genuinely
   * change.
   */
  const latest = useRef({ attachments, post, reply, room, threadRootId });
  useEffect(() => {
    latest.current = { attachments, post, reply, room, threadRootId };
  });

  const add = useCallback((files: File[]) => latest.current.attachments.addFiles(files), []);
  const remove = useCallback((fileId: string) => latest.current.attachments.removeFile(fileId), []);
  const retry = useCallback((fileId: string) => latest.current.attachments.retryFile(fileId), []);
  const cancel = useCallback(() => latest.current.attachments.cancelUpload(), []);

  const { pendingFiles, hasFailedUpload, isUploading } = attachments;
  const port = useMemo<ConversationAttachmentPort>(
    () => ({
      staged: pendingFiles,
      add,
      remove,
      retry,
      cancel,
      hasFailed: hasFailedUpload,
      isUploading,
      // Uploading IS part of a room's send — `send` awaits `uploadAndGetIds`
      // itself — so Enter never has to wait, and Escape keeps meaning the one
      // thing it means in a channel: take the `@` picker down.
      holdsSendWhileUploading: false,
    }),
    [pendingFiles, hasFailedUpload, isUploading, add, remove, retry, cancel]
  );

  const send = useCallback(async (draft: ConversationDraft): Promise<void> => {
    const {
      attachments: files,
      post: postNow,
      reply: replyNow,
      room: here,
      threadRootId,
    } = latest.current;
    if (here === undefined) throw new Error('That conversation is not loaded yet.');
    if (here.archived) throw new Error('This conversation is archived.');
    // **Posting into a room is an interaction with it** (DOR-1156). Today is
    // ordered by `max(userLastMessageAt, userLastOpenedAt)` and the client
    // half was only written by opening a row — so the home surface, which IS
    // #team and is arrived at rather than opened, could be written in all
    // morning and hold no record at all. A thread reply records the ROOM: a
    // thread reads its room's cursor, so one place has one record.
    useInteractionStore.getState().recordOpened('room', here.id);
    // Minted here, at the keystroke, because that is when the pending row
    // has to appear — before there is any server id to call it by.
    const clientId = newPendingId();
    const attachmentNames = files.pendingFiles.map((file) => file.file.name);
    // The batch identity, read in the same breath as the names: what this
    // send is sending, and therefore exactly what it may clear when it lands.
    const sentFileIds = files.pendingFiles.map((file) => file.id);
    const attachmentIds = await files.uploadAndGetIds();
    // Cleared only once the ids are safely in the message, and scoped to the
    // batch this send took — clearing the bar wholesale silently ate a file
    // dropped in during the upload.
    files.clearFiles(sentFileIds);
    // No per-call callbacks: a refusal is handled by the mutation itself,
    // which still runs when this composer is gone. See `usePostToRoom`.
    const rootId = draft.parentEntryId ?? threadRootId;
    if (rootId !== undefined) {
      replyNow.mutate({
        roomId: here.id,
        rootEntryId: rootId,
        text: draft.text,
        clientId,
        attachmentIds,
        attachmentNames,
      });
      return;
    }
    postNow.mutate({
      roomId: here.id,
      text: draft.text,
      clientId,
      attachmentIds,
      attachmentNames,
    });
  }, []);

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
      // Three refusals, three sentences, and the FIRST one matters most: a room
      // still being read is not a room you left, and answering "You left this
      // channel" while it loads told people they had lost access to somewhere
      // they were about to be standing in.
      ...(room === undefined
        ? { canSendReason: 'Still opening this conversation…' }
        : room.archived
          ? { canSendReason: 'This conversation is archived. You can read it, but not add to it.' }
          : !isMember
            ? { canSendReason: 'You left this channel. You can read it, but not add to it.' }
            : {}),
      send,
      // No `queue`: a room has no queue, and the composer draws no queue chrome
      // at all rather than a disabled one.
      attachments: port,
    }),
    [room, threadRootId, isMember, port, send]
  );

  return { target, attachments };
}
