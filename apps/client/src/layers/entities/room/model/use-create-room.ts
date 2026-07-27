/**
 * Open a new room — a channel, or a direct message with one agent or several.
 *
 * @module entities/room/model/use-create-room
 */
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/** Who a new direct message is with. */
export interface StartDirectMessageInput {
  /**
   * The agents' directories — each one's stable identity across
   * re-registration. One gives a one-to-one, several give a group.
   */
  agentPaths: string[];
  /** What to call the conversation; see `directMessageTitle`. */
  title: string;
}

/**
 * Create a channel. The caller joins it, and its `#slug` is derived from the
 * name unless the server finds nothing sluggable in it.
 */
export function useCreateChannel(): UseMutationResult<RoomWithRoster, Error, string> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (title: string) =>
      transport.createRoom({ kind: 'channel', title, members: [], agentPaths: [] }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roomKeys.all }),
  });
}

/**
 * Start a direct message with one agent, or with several at once.
 *
 * One call however many agents are in it. It used to be two — create, then join
 * by directory — because the create endpoint only seeded a roster from author
 * ids, and an agent that has never spoken has no author row to name. That made
 * a failed second call leave a direct message with nobody in it: a room named
 * after an agent the agent was not in, which retrying could not repair because
 * the room already existed. `agentPaths` resolves inside the same transaction,
 * so either the whole conversation exists or none of it does.
 *
 * Asking twice for the same people is safe: the server matches a direct message
 * on its exact member set and answers with the conversation you already have
 * rather than a second one beside it (`RoomService.createRoom`). So nothing here
 * has to know which conversations exist before offering to open one.
 */
export function useStartDirectMessage(): UseMutationResult<
  RoomWithRoster,
  Error,
  StartDirectMessageInput
> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ agentPaths, title }: StartDirectMessageInput) =>
      transport.createRoom({ kind: 'dm', title, members: [], agentPaths }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: roomKeys.all }),
  });
}
