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
 * What it DOES write is a pending row (`pending-posts`), which is a different
 * kind of thing: drawn beside the log rather than in it, carrying no `seq`, and
 * retired by the echo. That is the answer to the hole this shape left — between
 * Enter and the echo there was nothing on screen at all, so on a slow link the
 * words simply vanished for the round trip, and under a stalled stream they
 * vanished for good.
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
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { PostToRoomResponse, RoomEntry } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { usePendingPostStore } from './pending-posts';

/** What to say, and where. */
export interface PostToRoomInput {
  /** The room to post into. */
  roomId: string;
  /** The message body. Already trimmed by the caller; the server rejects empty. */
  text: string;
  /**
   * This client's id for the attempt, so the words have a row to sit in while
   * they are in the air.
   *
   * Passed back unchanged on a retry, which is what makes trying again move the
   * row already on screen rather than stack a second copy of the sentence.
   */
  clientId: string;
  /**
   * The files to send with it, already uploaded, in the order they render.
   *
   * Ids rather than bytes: the upload is its own request, and it has already
   * happened by the time this runs.
   */
  attachmentIds?: string[];
  /**
   * What to call those files while the message is still in the air.
   *
   * NAMES, because the entry does not exist yet — there is nothing to link to
   * and nothing to draw a thumbnail from. See `PendingPost.attachmentNames`.
   */
  attachmentNames?: string[];
}

/**
 * Tie an accepted attempt to the entry it will arrive as — or retire it now, if
 * the entry has already beaten the 202 home.
 *
 * The race is real and not rare: the entry is fanned out before the response
 * reaches the browser, so `useRoomStream` can merge it while this request is
 * still in flight. The `settle` that echo runs finds a row with no `entryId`
 * yet and matches nothing, so without this check the row would sit under its own
 * echo with nothing left ever to clear it.
 *
 * @param queryClient - The cache the stream merges into.
 * @param roomId - The room posted to.
 * @param clientId - The attempt.
 * @param entryId - The identity the server answered with.
 * @internal Shared with `use-reply-in-thread`, which has the identical race.
 */
export function reconcilePendingPost(
  queryClient: QueryClient,
  roomId: string,
  clientId: string,
  entryId: string
): void {
  const store = usePendingPostStore.getState();
  store.accepted(clientId, entryId);
  const held = queryClient.getQueryData<RoomEntry[]>(roomKeys.entries(roomId));
  if (held?.some((entry) => entry.id === entryId) === true) store.settle(roomId, entryId);
}

/**
 * Send a message to a room.
 *
 * Resolves with the accepted entry's identity, never with the entry — read the
 * room's stream for that. The words stay on screen as a pending row from the
 * keystroke until the room echoes them back.
 *
 * A refusal turns that row into a failed one carrying the same words and a way
 * to try again, and reports the server's own sentence (`This room is archived`,
 * `Not a member of this room`) through the shared mutation toast, which is fit
 * to show a person as-is.
 *
 * **A refusal no longer pushes the words back into the composer**, and that is a
 * deliberate reversal. Restoring was the best answer available when nothing else
 * held them, but it merges a refused sentence into whatever has been typed since
 * — two sentences with a claim on one box — and it cannot say WHICH message
 * failed once two are in flight. The failed row says both, in the place the
 * message was already sitting.
 */
export function usePostToRoom(): UseMutationResult<PostToRoomResponse, Error, PostToRoomInput> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    // `attachmentIds` is omitted rather than sent empty: a message with no files
    // asks for exactly what it asked for before this field existed.
    mutationFn: ({ roomId, text, attachmentIds }: PostToRoomInput) =>
      transport.postToRoom(
        roomId,
        attachmentIds !== undefined && attachmentIds.length > 0 ? { text, attachmentIds } : { text }
      ),
    onMutate: ({ roomId, text, clientId, attachmentIds, attachmentNames }) => {
      usePendingPostStore.getState().start({
        clientId,
        roomId,
        threadRootId: null,
        text,
        attachmentIds: attachmentIds ?? [],
        attachmentNames: attachmentNames ?? [],
      });
    },
    onSuccess: (accepted, { roomId, clientId }) =>
      reconcilePendingPost(queryClient, roomId, clientId, accepted.entryId),
    onError: (_error, { clientId }) => usePendingPostStore.getState().failed(clientId),
    // Names the action for the shared mutation toast, which then reads
    // "Couldn't send your message — This room is archived". Suppressing that
    // toast and raising our own at the call site was the earlier shape, and it
    // lost the message entirely in exactly the cases this hook now survives.
    meta: { errorLabel: "Couldn't send your message" },
  });
}
