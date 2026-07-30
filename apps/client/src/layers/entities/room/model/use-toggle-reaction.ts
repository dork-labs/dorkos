/**
 * Put an emoji on a message, or take it back.
 *
 * **Optimistic, unlike every other room write.** Posting deliberately draws
 * nothing until the server's own copy arrives, because an entry needs a `seq`
 * only the server can mint. A reaction has no such problem — it is state on an
 * entry the reader already holds — and it is the one room act fast enough that
 * a round trip is felt: a pill that appears 200ms after the press reads as a
 * button that did not work.
 *
 * **The stream is authoritative, not the response.** The 202 says only which way
 * THIS click went; somebody else may have reacted in between, and the entry's
 * whole set arrives on the room's SSE stream where `useRoomStream` replaces it
 * outright. So the optimistic write here is a guess that the stream corrects,
 * never a second source of truth.
 *
 * @module entities/room/model/use-toggle-reaction
 */
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type {
  RoomEntry,
  RoomWithRoster,
  ToggleReactionResponse,
} from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { applyReactionToggle, mergeRoomReactions } from '../lib/reactions';

/** Which emoji, on which message, for whom. */
export interface ToggleReactionInput {
  /** The room the entry lives in. */
  roomId: string;
  /** The entry the emoji attaches to. */
  entryId: string;
  /** The emoji being put on or taken off. */
  emoji: string;
  /** The reader's own author id here — who the optimistic pill is drawn for. */
  viewerAuthorId: string;
}

/**
 * What the revert needs: which way the click went.
 *
 * Deliberately NOT the set as it stood before the click. A snapshot is a
 * photograph of a row that other people are still writing to, and replaying it
 * on failure erases whatever landed in between — see {@link useToggleReaction}.
 */
interface ToggleReactionContext {
  /** The state this click asked the server for. Undoing it means the opposite. */
  on: boolean;
}

/**
 * React to a message, and un-react.
 *
 * The pill is drawn on the press and the request **names the state it is asking
 * for** (`on: true | false`) rather than sending a bare flip. A flip is the one
 * body a retry cannot survive — sent twice it undoes itself — and naming the
 * state makes the call idempotent in effect, which is what lets the optimistic
 * draw and the request disagree about timing without disagreeing about outcome.
 *
 * **A refusal undoes YOUR membership, and touches nothing else.** The obvious
 * revert — put back the set photographed before the click — is wrong here, and
 * wrong in a way that leaves the row silently incorrect until a reload:
 *
 *   1. you react, and the pill is drawn optimistically;
 *   2. somebody else reacts, and their frame replaces the entry's set with the
 *      one the SERVER holds, which does not include your write yet;
 *   3. your write is refused.
 *
 * Replaying the snapshot at step 3 erases step 2 — and nothing puts it back,
 * because nothing changed server-side, so no further frame is coming. So the
 * revert applies the INVERSE toggle against whatever the cache holds now:
 * `(entry, you, emoji)` is the only thing this write ever owned, and it is the
 * only thing the undo may touch. The pill then leaves on the plain fade removal
 * always uses — no celebration for a failure.
 *
 * The toast carries a fixed id, so a reader pressing a dead room's pills five
 * times is told once rather than five times.
 */
export function useToggleReaction(): UseMutationResult<
  ToggleReactionResponse,
  Error,
  ToggleReactionInput,
  ToggleReactionContext
> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<ToggleReactionResponse, Error, ToggleReactionInput, ToggleReactionContext>({
    onMutate: ({ roomId, entryId, emoji, viewerAuthorId }) => {
      const held = queryClient.getQueryData<RoomEntry[]>(roomKeys.entries(roomId));
      const previous = held?.find((candidate) => candidate.id === entryId)?.reactions;
      const { reactions, on } = applyReactionToggle(previous, emoji, viewerAuthorId);
      queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(roomId), (cached) =>
        mergeRoomReactions(cached, entryId, reactions)
      );
      return { on };
    },

    mutationFn: ({ roomId, entryId, emoji, viewerAuthorId }) => {
      // Read back out of the cache the `onMutate` above just wrote, so the state
      // asked for is exactly the state drawn — rather than recomputed here from
      // a set the optimistic write has already moved on from.
      const held = queryClient.getQueryData<RoomEntry[]>(roomKeys.entries(roomId));
      const on =
        held
          ?.find((candidate) => candidate.id === entryId)
          ?.reactions?.some(
            (reaction) => reaction.emoji === emoji && reaction.authorIds.includes(viewerAuthorId)
          ) ?? false;
      return transport.toggleReaction(roomId, entryId, { emoji, on });
    },

    onError: (_error, { roomId, entryId, emoji, viewerAuthorId }, context) => {
      // Nothing was drawn, so there is nothing to undo.
      if (context === undefined) return;
      queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(roomId), (cached) => {
        const current = cached?.find((candidate) => candidate.id === entryId)?.reactions;
        // The inverse of what was asked for, against the row as it stands NOW.
        // Idempotent by construction: if a frame has already overwritten this
        // reader's optimistic pill, undoing it is a no-op rather than a wipe.
        const { reactions } = applyReactionToggle(current, emoji, viewerAuthorId, !context.on);
        return mergeRoomReactions(cached, entryId, reactions);
      });
    },

    // The reader's quick row, recomputed with this reaction counted. Written
    // rather than invalidated: the answer already carries it, and refetching the
    // room would redraw the roster and the masthead for a change to three emoji.
    onSuccess: ({ frequents }, { roomId }) => {
      queryClient.setQueryData<RoomWithRoster>(roomKeys.detail(roomId), (room) =>
        room ? { ...room, reactionFrequents: frequents } : room
      );
    },

    meta: {
      errorLabel: "Couldn't add your reaction",
      // Reacting is the one act a person can fire ten times in three seconds, so
      // repeated failures replace one another instead of stacking up a column of
      // identical toasts.
      errorToastId: 'room-reaction',
    },
  });
}
