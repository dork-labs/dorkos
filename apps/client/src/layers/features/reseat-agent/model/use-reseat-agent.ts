/**
 * The two calls behind "Continue on another account…" for an agent in a room:
 * where its seat could move, and the move.
 *
 * @module features/reseat-agent/model/use-reseat-agent
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** The query key for a seat's move options. */
export function reseatOptionsKey(roomId: string, authorId: string) {
  return ['rooms', roomId, 'reseat-options', authorId] as const;
}

/**
 * Read where an agent's seat in a room could move. Fetched only while
 * `enabled` (the picker is open), and fresh each time, since usage moves.
 *
 * @param roomId - The room.
 * @param authorId - The agent.
 * @param enabled - Whether to fetch now.
 */
export function useReseatOptions(roomId: string, authorId: string, enabled: boolean) {
  const transport = useTransport();
  return useQuery({
    queryKey: reseatOptionsKey(roomId, authorId),
    queryFn: () => transport.getRoomReseatOptions(roomId, authorId),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Move an agent's seat in a room to another account.
 *
 * @param roomId - The room.
 * @param authorId - The agent.
 */
export function useReseatAgent(roomId: string, authorId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (account: string) => transport.reseatRoomAgent(roomId, authorId, { account }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reseatOptionsKey(roomId, authorId) });
    },
  });
}
