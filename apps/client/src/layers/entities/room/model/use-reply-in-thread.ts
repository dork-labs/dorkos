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
 * A refusal gives the words back to the box they were typed in — the thread
 * panel's own draft, keyed by `threadDraftKey`. That restore runs at this level
 * rather than at the call site because the call site does not reliably exist
 * when a refusal lands: the reader can close the panel first, and a second
 * reply detaches the first one's observer, after which per-call `onError`
 * callbacks are never dispatched at all. See `usePostToRoom` for the full
 * story.
 *
 * The words MERGE rather than replace what is in the box by then (`restore`):
 * a refusal arrives after the send, and two sentences both have a claim on the
 * panel's composer by that point. Choosing one means destroying the other.
 *
 * There is no aim to give back, and that is the thread panel's doing (design
 * record §3). A reply used to be written in the ROOM's composer, silently
 * re-aimed at a thread, so a refusal had to restore both the words and the aim
 * or the reader's next Enter would land in the wrong conversation. The panel
 * removed the ambiguity it was guarding: a thread reply is typed in the thread.
 *
 * @module entities/room/model/use-reply-in-thread
 */
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { PostToRoomResponse } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { useRoomDraftStore } from './room-drafts';

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
   * Where refused words belong: the panel composer's own draft key.
   *
   * Required rather than defaulted to the room, because a thread reply is
   * always typed in a thread's own box now, and quietly restoring somebody's
   * sentence into a different conversation is the one failure this cannot be
   * allowed to have a default for.
   */
  draftKey: string;
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

  return useMutation({
    mutationFn: ({ roomId, rootEntryId, text }: ReplyInThreadInput) =>
      transport.replyInThread(roomId, { rootEntryId, text }),
    onError: (_error, { text, draftKey }) => {
      useRoomDraftStore.getState().restore(draftKey, text);
    },
    // Reads "Couldn't send your reply — This room is archived" through the
    // shared mutation toast, which is fit to show a person as-is.
    meta: { errorLabel: "Couldn't send your reply" },
  });
}
