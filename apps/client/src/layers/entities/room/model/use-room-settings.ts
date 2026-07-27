/**
 * Change what a room is — its name, its topic, whether it is archived.
 *
 * @module entities/room/model/use-room-settings
 */
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { RoomWithRoster, UpdateRoomRequest } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/** One room settings patch: which room, and what to change about it. */
export interface UpdateRoomInput {
  /** The room being changed. */
  roomId: string;
  /** The fields to change; anything omitted is left alone. */
  patch: UpdateRoomRequest;
}

/**
 * Patch a room's title, topic or archived flag.
 *
 * Archiving is reversible through this same hook (`{ archived: false }`), which
 * is what lets the sidebar offer an undo rather than making a room vanish for
 * good. Un-archiving a channel can still be refused when another channel has
 * taken its `#slug` in the meantime — the error carries that message.
 *
 * Invalidates the room list and this room's detail, deliberately NOT
 * `roomKeys.all`: that prefix-matches the room's entries, and refetching the
 * open room's history mid-stream can drop an entry SSE has already delivered
 * (see `use-mark-room-read.ts` for the full reasoning).
 */
export function useUpdateRoom(): UseMutationResult<RoomWithRoster, Error, UpdateRoomInput> {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ roomId, patch }: UpdateRoomInput) => transport.updateRoom(roomId, patch),
    onSuccess: (_room, { roomId }) => {
      void queryClient.invalidateQueries({ queryKey: roomKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: roomKeys.detail(roomId) });
    },
  });
}
