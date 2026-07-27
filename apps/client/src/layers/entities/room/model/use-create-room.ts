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
    mutationFn: (title: string) => transport.createRoom({ kind: 'channel', title, members: [] }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roomKeys.all }),
  });
}

/**
 * Start a direct message with one agent.
 *
 * Two calls, because the create endpoint seeds a roster from author ids and an
 * agent that has never spoken has no author row yet — `POST /members` is what
 * mints one from its directory. They are not one transaction: if the join fails
 * the room still exists, so the list is invalidated either way and the caller
 * sees a real error rather than a room that silently has nobody in it.
 */
export function useStartDirectMessage(): UseMutationResult<
  RoomWithRoster,
  Error,
  StartDirectMessageInput
> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentPath, title }: StartDirectMessageInput) => {
      const room = await transport.createRoom({ kind: 'dm', title, members: [] });
      await transport.addRoomMember(room.id, { agentPath });
      return room;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: roomKeys.all }),
  });
}
