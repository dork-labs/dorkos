/**
 * Stop ONE agent's turn in a room, and leave the others working.
 *
 * The room-wide stop (`use-halt-room.ts`) with a scope, not a second verb: it
 * reaches the same halt path on the server, which marks the stopped dispatch
 * before it does anything that can yield, so a turn that streams its last words
 * after the interrupt has them thrown away. The case it exists for is the common
 * one — three agents answer, one goes down a wrong path, and the only button
 * that could stop it used to stop the two doing useful work.
 *
 * Nothing is written into the entry cache, for the reason
 * {@link import('./use-halt-room').useHaltRoom} has none: the `halted` notice
 * naming who stopped whom arrives on the room's own stream, and the stopped
 * agent's working indicator clears from the same stream when its claim drops.
 *
 * @module entities/room/model/use-halt-agent
 */
import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { HaltRoomResponse } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';

/** Which agent to stop, and where. */
export interface HaltAgentInput {
  roomId: string;
  /** The agent's author id in that room. */
  authorId: string;
}

/**
 * Stop one agent in a room.
 *
 * Resolves with `1` when a turn was interrupted and `0` when that agent was not
 * running one here. `0` is a success, not a failure: the room says so in its own
 * voice either way.
 */
export function useHaltAgent(): UseMutationResult<HaltRoomResponse, Error, HaltAgentInput> {
  const transport = useTransport();

  return useMutation({
    mutationFn: ({ roomId, authorId }: HaltAgentInput) => transport.haltRoomAgent(roomId, authorId),
    // Named for the shared mutation toast, which then reads "Couldn't stop this
    // agent — No such agent in this room." Handled here rather than at the call
    // site because the row that was pressed may already be gone by the time a
    // refusal lands: the peek draws only the agents that are working.
    meta: { errorLabel: "Couldn't stop this agent" },
  });
}
