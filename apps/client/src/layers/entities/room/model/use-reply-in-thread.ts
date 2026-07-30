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
 * where the timeline gathers it under its root. Nothing is written into the
 * entry cache from here.
 *
 * A refusal gives back BOTH halves of what was in flight: the words go back
 * into the room's draft, and the composer goes back to aiming at the thread
 * they were written for. Restoring only the text would put the next Enter in
 * the room instead of the thread, silently, which is the one failure this hook
 * exists to prevent. Both restores run at this level rather than at the call
 * site, because the call site does not reliably exist when a refusal lands —
 * see `usePostToRoom` for why.
 *
 * **Neither half overwrites what the reader did in the meantime.** A refusal
 * arrives after the send, and the composer need not have stood still: the words
 * merge rather than replace (`restore`), and the aim is only taken back when it
 * is still on this thread or on nothing (`restoreAim`). Someone who moved to a
 * different thread while this was in flight keeps it, and keeps their caret —
 * pulling either one back would be the same silent misdelivery in the other
 * direction.
 *
 * @module entities/room/model/use-reply-in-thread
 */
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { PostToRoomResponse } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { useRoomReplyTargetStore } from './reply-targets';
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
    onError: (_error, { roomId, rootEntryId, text }) => {
      useRoomDraftStore.getState().restore(roomId, text);
      useRoomReplyTargetStore.getState().restoreAim(roomId, rootEntryId);
    },
    // Reads "Couldn't send your reply — This room is archived" through the
    // shared mutation toast, which is fit to show a person as-is.
    meta: { errorLabel: "Couldn't send your reply" },
  });
}
