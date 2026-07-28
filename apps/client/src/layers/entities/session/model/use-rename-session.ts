import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport } from '@/layers/shared/model';
import type { Session } from '@dorkos/shared/types';
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';

/**
 * Optimistic rename mutation for sessions.
 *
 * Updates the title instantly in the query cache, then persists via
 * `transport.updateSession`. On error the cache is rolled back and a
 * toast is shown.
 *
 * @param cwd - Current working directory (agent path) used as the sessions query key segment.
 */
export function useRenameSession(cwd: string | null) {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      transport.updateSession(sessionId, { title }, cwd ?? undefined),

    onMutate: async ({ sessionId, title }) => {
      // Cancel any in-flight session queries so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: sessionKeys.listRoot });

      // Snapshot the previous value for rollback
      const previous = queryClient.getQueryData<Session[]>(sessionKeys.list(cwd));

      // Optimistically update the cache
      queryClient.setQueryData<Session[]>(sessionKeys.list(cwd), (old) =>
        old?.map((s) => (s.id === sessionId ? { ...s, title } : s))
      );

      return { previous };
    },

    onError: (_err, _vars, context) => {
      // Roll back to the previous cache state
      if (context?.previous) {
        queryClient.setQueryData(sessionKeys.list(cwd), context.previous);
      }
      toast.error('Failed to rename session');
    },

    onSettled: () => {
      // Always refetch after mutation to ensure cache consistency
      queryClient.invalidateQueries({ queryKey: sessionKeys.listRoot });
    },
  });
}
