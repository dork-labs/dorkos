/**
 * Reply inside a thread.
 *
 * The thread twin of `usePostToRoom`, and deliberately its own mutation rather
 * than a flag on it — the routes are split for the same reason, so that writing
 * into a thread is a deliberate act with a required target and never an omitted
 * parameter.
 *
 * Everything `usePostToRoom` says about trigger-only delivery applies here
 * unchanged: the 202 carries the reply's identity, the reply itself arrives on
 * the room's SSE stream, and `useRoomStream` merges it by `seq` — which is also
 * where the open thread panel picks it up. Nothing is written into the entry
 * cache from here.
 *
 * A reply in flight is a pending row at the tail of the thread it was typed in,
 * and a refusal turns that row into a failed one carrying the same words and a
 * way to try again. That handling runs at this level rather than at the call
 * site because the call site does not reliably exist when a refusal lands: the
 * reader can close the panel first, and a second reply detaches the first one's
 * observer, after which per-call `onError` callbacks are never dispatched at
 * all. See `usePostToRoom` for the full story, including why the words no
 * longer go back into the composer.
 *
 * There is no aim to give back, and that is the thread panel's doing (design
 * record §3). A reply used to be written in the ROOM's composer, silently
 * re-aimed at a thread, so a refusal had to restore both the words and the aim
 * or the reader's next Enter would land in the wrong conversation. The panel
 * removed the ambiguity it was guarding: a thread reply is typed in the thread.
 *
 * @module entities/room/model/use-reply-in-thread
 */
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { PostToRoomResponse } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { usePendingPostStore } from './pending-posts';
import { reconcilePendingPost } from './use-post-to-room';

/** What to say, and which thread to say it in. */
export interface ReplyInThreadInput {
  /** The room holding the thread. */
  roomId: string;
  /**
   * The entry the thread hangs off. Already resolved with `replyRootFor`, so
   * this is never itself a reply — the server refuses that.
   */
  rootEntryId: string;
  /** The reply body. Already trimmed by the caller; the server rejects empty. */
  text: string;
  /**
   * This client's id for the attempt, so the words have a row to sit in while
   * they are in the air. Passed back unchanged on a retry.
   */
  clientId: string;
  /** The files to send with it, already uploaded, in the order they render. */
  attachmentIds?: string[];
  /** What to call those files while the reply is still in the air. */
  attachmentNames?: string[];
}

/**
 * Send a reply into a thread.
 *
 * Resolves with the accepted reply's identity, never with the reply — read the
 * room's stream for that. It is an addressing act like any other post: it can
 * trigger the agents it names, it spends the room's turn budget, and it enters
 * the same cascade guard, all of which the route runs.
 */
export function useReplyInThread(): UseMutationResult<
  PostToRoomResponse,
  Error,
  ReplyInThreadInput
> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    // `attachmentIds` is omitted rather than sent empty, exactly as in
    // `usePostToRoom`: a reply with no files asks for what it always asked for.
    mutationFn: ({ roomId, rootEntryId, text, attachmentIds }: ReplyInThreadInput) =>
      transport.replyInThread(
        roomId,
        attachmentIds !== undefined && attachmentIds.length > 0
          ? { rootEntryId, text, attachmentIds }
          : { rootEntryId, text }
      ),
    onMutate: ({ roomId, rootEntryId, text, clientId, attachmentIds, attachmentNames }) => {
      usePendingPostStore.getState().start({
        clientId,
        roomId,
        threadRootId: rootEntryId,
        text,
        attachmentIds: attachmentIds ?? [],
        attachmentNames: attachmentNames ?? [],
      });
    },
    onSuccess: (accepted, { roomId, clientId }) =>
      reconcilePendingPost(queryClient, roomId, clientId, accepted.entryId),
    onError: (_error, { clientId }) => usePendingPostStore.getState().failed(clientId),
    // Reads "Couldn't send your reply — This room is archived" through the
    // shared mutation toast, which is fit to show a person as-is.
    meta: { errorLabel: "Couldn't send your reply" },
  });
}
