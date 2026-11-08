/**
 * One agent-made change to another agent's access to a connected app, as the
 * person reads it and undoes it (spec `agent-grant-autonomy`). The reason is
 * read here, from the person's own route, never from the notification.
 *
 * @module entities/connectors/model/use-access-changes
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/** The cache key of one access change. */
export function accessChangeKey(changeId: string) {
  return [...connectorKeys.all, 'access-change', changeId] as const;
}

/**
 * One access change, with the agent's own reason.
 *
 * @param changeId - The change, as its Needs-you item names it.
 */
export function useAccessChange(changeId: string) {
  const transport = useTransport();
  return useQuery({
    queryKey: accessChangeKey(changeId),
    queryFn: () => transport.getAccessChange(changeId),
    staleTime: 30_000,
  });
}

/** Put back what one agent-made change took away. The calling button shows its own failure. */
export function useUndoAccessChange() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changeId: string) => transport.undoAccessChange(changeId),
    onSuccess: (_result, changeId) => {
      void queryClient.invalidateQueries({ queryKey: accessChangeKey(changeId) });
      void queryClient.invalidateQueries({ queryKey: connectorKeys.all });
    },
    meta: { errorLabel: 'Couldn’t give access back', isShownInline: () => true },
  });
}
