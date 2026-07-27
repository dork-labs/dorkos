/**
 * Post to a room.
 *
 * Deliberately writes nothing into the cache. The post is trigger-only: the
 * server answers with the entry's identity and delivers the entry itself on the
 * room's SSE stream, where `useRoomStream` merges it by `seq` — the same path
 * every agent reply the post triggers arrives on. An optimistic insert would
 * need a `seq` only the server can mint, and would then fight that merge. The
 * sidebar's row order and unread counts refresh from the global `room_activity`
 * event, so there is nothing to invalidate here either.
 *
 * @module entities/room/model/use-post-to-room
 */
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { PostToRoomResponse } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';

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
 * room's stream for that. Rejects with the server's own sentence (`This room is
 * archived`, `Not a member of this room`), which is fit to show a person as-is.
 */
export function usePostToRoom(): UseMutationResult<PostToRoomResponse, Error, PostToRoomInput> {
  const transport = useTransport();

  return useMutation({
    mutationFn: ({ roomId, text }: PostToRoomInput) => transport.postToRoom(roomId, { text }),
    // The composer shows the server's own sentence. Without this the global
    // `MutationCache.onError` also fires, so a refusal lands as two toasts —
    // the generic "Action failed. Please try again." first, then the real one.
    meta: { suppressErrorToast: true },
  });
}
