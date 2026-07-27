/**
 * Post to a room.
 *
 * Deliberately writes nothing into the entry cache. The post is trigger-only:
 * the server answers with the entry's identity and delivers the entry itself on
 * the room's SSE stream, where `useRoomStream` merges it by `seq` — the same
 * path every agent reply the post triggers arrives on. An optimistic insert
 * would need a `seq` only the server can mint, and would then fight that merge.
 * The sidebar's row order and unread counts refresh from the global
 * `room_activity` event, so there is nothing to invalidate here either.
 *
 * Failure handling lives at this level rather than at the call site, because
 * the call site does not reliably exist when a refusal lands. TanStack runs a
 * mutation's OWN `onError` unconditionally (`mutation.js:159`) but dispatches
 * the per-call `mutate(…, { onError })` callbacks only while the observer still
 * has listeners (`mutationObserver.js:77`) — and both leaving the room and
 * sending a second message detach it (`:56-58`). A refusal handled at the call
 * site is a refusal that can silently disappear.
 *
 * @module entities/room/model/use-post-to-room
 */
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { PostToRoomResponse } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { useRoomDraftStore } from './room-drafts';

/** What to say, and where. */
export interface PostToRoomInput {
  /** The room to post into. */
  roomId: string;
  /** The message body. Already trimmed by the caller; the server rejects empty. */
  text: string;
}

/**
 * Send a message to a room.
 *
 * Resolves with the accepted entry's identity, never with the entry — read the
 * room's stream for that. A refusal puts the words back into that room's draft
 * and reports the server's own sentence (`This room is archived`, `Not a member
 * of this room`) through the shared mutation toast, which is fit to show a
 * person as-is.
 */
export function usePostToRoom(): UseMutationResult<PostToRoomResponse, Error, PostToRoomInput> {
  const transport = useTransport();

  return useMutation({
    mutationFn: ({ roomId, text }: PostToRoomInput) => transport.postToRoom(roomId, { text }),
    onError: (_error, { roomId, text }) => useRoomDraftStore.getState().restore(roomId, text),
    // Names the action for the shared mutation toast, which then reads
    // "Couldn't send your message — This room is archived". Suppressing that
    // toast and raising our own at the call site was the earlier shape, and it
    // lost the message entirely in exactly the cases this hook now survives.
    meta: { errorLabel: "Couldn't send your message" },
  });
}
