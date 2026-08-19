/**
 * Ask for this room to be the next one a busy agent answers.
 *
 * One agent is one working directory, so a message addressed to an agent that is
 * mid-turn somewhere else waits here rather than being refused. This is the one
 * control a person has over that wait, and what it does is **reorder**: the turn
 * in the way is untouched, nothing is interrupted, and the promoted message
 * still waits for the agent to be free. A room that gets passed over is next
 * after that.
 *
 * **Why it is not "stop what it's doing over there".** Stopping is a control
 * action with a room-wide notice behind it and a gather buffer to drop, and it
 * belongs in the room where the person can see what they would be stopping —
 * which the peek's other action is how you reach.
 *
 * Nothing is written into any cache. The reordering shows up as the answer
 * landing here first; until then the waiting line says what it always said.
 *
 * @module entities/room/model/use-promote-hold
 */
import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { PromoteHoldResponse } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';

/** Which room, and which agent it is waiting on. */
export interface PromoteHoldInput {
  roomId: string;
  authorId: string;
}

/**
 * Ask for this room's waiting message to go to the front of that agent's queue.
 *
 * Resolves with `promoted: false` when there was nothing waiting. That is a
 * success, not a failure: the wait ended between the button being drawn and
 * being pressed, which is the ordinary way a wait ends.
 */
export function usePromoteHold(): UseMutationResult<PromoteHoldResponse, Error, PromoteHoldInput> {
  const transport = useTransport();

  return useMutation({
    mutationFn: ({ roomId, authorId }: PromoteHoldInput) => transport.promoteHold(roomId, authorId),
    // Named for the shared mutation toast, which then reads "Couldn't ask to be
    // answered first — No such room". Handled here rather than at the call site
    // because the button may well be gone by the time a refusal lands: it only
    // shows while a message is waiting, and the wait can end on its own.
    meta: { errorLabel: "Couldn't ask to be answered first" },
  });
}
