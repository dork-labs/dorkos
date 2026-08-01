/**
 * Stop every agent turn running in one room.
 *
 * **A control action, and the reason it is one.** In the Hermes loop incident of
 * 26 May 2026 an operator typed "you are in a loop, stop" and the bot carried on
 * replying, because to a model in a conversation that sentence is one more turn
 * to answer. So stopping cannot be something you say — it has to be something
 * you press, reaching the runtimes rather than the models
 * (room-participation spec §10.4). Nothing in this product infers it from
 * message text, here or on the server.
 *
 * Nothing is written into the entry cache. The `halted` notice the server writes
 * arrives on the room's own stream, where `useRoomStream` merges it by `seq`,
 * exactly as an agent's reply does — and the working indicators clear from the
 * same stream when the claims drop. So this hook's only job is to ask, and to
 * say so when the asking fails.
 *
 * @module entities/room/model/use-halt-room
 */
import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { HaltRoomResponse } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';

/** Which room to stop. */
export interface HaltRoomInput {
  roomId: string;
}

/**
 * Stop everything running in a room.
 *
 * Resolves with how many turns were interrupted. `0` is a success, not a
 * failure: the room was already idle, and it says so in its own voice too.
 */
export function useHaltRoom(): UseMutationResult<HaltRoomResponse, Error, HaltRoomInput> {
  const transport = useTransport();

  return useMutation({
    mutationFn: ({ roomId }: HaltRoomInput) => transport.haltRoom(roomId),
    // Named for the shared mutation toast, which then reads "Couldn't stop this
    // room — No such room". Handled at this level rather than at the call site
    // because the button that pressed it may well be gone by the time a refusal
    // lands: the control only shows while something is working, and the thing
    // that was working may have finished on its own.
    meta: { errorLabel: "Couldn't stop this room" },
  });
}
