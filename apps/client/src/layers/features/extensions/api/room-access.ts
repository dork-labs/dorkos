/**
 * Which rooms a mini app may read and reply in as the person (DOR-3017): the
 * read and the one writer behind Settings → Extensions.
 *
 * @module features/extensions/api/room-access
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { extensionApiUrl } from '../model/extension-api-url';
import { extensionKeys } from './queries';

/** The cache key for one mini app's rooms. */
const roomAccessKey = (id: string) => [...extensionKeys.detail(id), 'room-access'] as const;

/**
 * The rooms the person picked for one mini app.
 *
 * @param extensionId - The mini app.
 */
export function useRoomAccess(extensionId: string) {
  return useQuery({
    queryKey: roomAccessKey(extensionId),
    queryFn: async (): Promise<string[]> => {
      const res = await fetch(extensionApiUrl(`/extensions/${extensionId}/room-access`));
      if (!res.ok) throw new Error(`Couldn’t load the rooms. The server answered ${res.status}.`);
      return ((await res.json()) as { roomIds: string[] }).roomIds;
    },
  });
}

/**
 * Replace the rooms one mini app may use.
 *
 * @param extensionId - The mini app.
 */
export function useSetRoomAccess(extensionId: string) {
  const queryClient = useQueryClient();
  return useMutation<string[], Error, string[]>({
    mutationFn: async (roomIds) => {
      const res = await fetch(extensionApiUrl(`/extensions/${extensionId}/room-access`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomIds }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? 'Couldn’t save the rooms. Try again.');
      }
      return ((await res.json()) as { roomIds: string[] }).roomIds;
    },
    onSuccess: (roomIds) => {
      queryClient.setQueryData(roomAccessKey(extensionId), roomIds);
    },
  });
}
