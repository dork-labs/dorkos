import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport } from '@/layers/shared/model';
import type { Session } from '@dorkos/shared/types';

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
      await queryClient.cancelQueries({ queryKey: ['sessions'] });

      // Snapshot the previous value for rollback
      const previous = queryClient.getQueryData<Session[]>(['sessions', cwd]);

      // Optimistically update the cache
      queryClient.setQueryData<Session[]>(['sessions', cwd], (old) =>
        old?.map((s) => (s.id === sessionId ? { ...s, title } : s))
      );

      return { previous };
    },

    onError: (_err, _vars, context) => {
      // Roll back to the previous cache state
      if (context?.previous) {
        queryClient.setQueryData(['sessions', cwd], context.previous);
      }
      toast.error('Failed to rename session');
    },

    onSettled: () => {
      // Always refetch after mutation to ensure cache consistency
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
