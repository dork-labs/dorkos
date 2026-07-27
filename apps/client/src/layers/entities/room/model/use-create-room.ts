/**
 * Open a new room — a channel, or a direct message with one agent.
 *
 * @module entities/room/model/use-create-room
 */
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/** Who a new direct message is with. */
export interface StartDirectMessageInput {
  /** The agent's directory — its stable identity across re-registration. */
  agentPath: string;
  /** What to call the conversation; the agent's display name. */
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
 * Start a direct message with one agent.
 *
 * One call. It used to be two — create, then join by directory — because the
 * create endpoint only seeded a roster from author ids, and an agent that has
 * never spoken has no author row to name. That made a failed second call leave
 * a direct message with nobody in it: a room named after an agent the agent was
 * not in, which retrying could not repair because the room already existed.
 * `agentPaths` resolves inside the same transaction, so either the whole
 * conversation exists or none of it does.
 */
export function useStartDirectMessage(): UseMutationResult<
  RoomWithRoster,
  Error,
  StartDirectMessageInput
> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ agentPath, title }: StartDirectMessageInput) =>
      transport.createRoom({ kind: 'dm', title, members: [], agentPaths: [agentPath] }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: roomKeys.all }),
  });
}
