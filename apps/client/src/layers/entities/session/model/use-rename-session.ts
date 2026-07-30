import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useClaudeAccounts, useTransport } from '@/layers/shared/model';
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
 * ## Renaming a session on an account that is not the active one
 *
 * The rename is saved either way. What the operator sees afterwards is not:
 * DorkOS only reads a Claude session's custom title while that session's account
 * is the active one, so a rename on another account persists but the list keeps
 * showing the derived title until they switch (spec `claude-code-accounts` D8).
 *
 * Left alone that reads as "rename did nothing", so this hook says plainly where
 * the new name will appear. It does NOT fake a lasting local title, and it does
 * not disable a rename that genuinely works — both would trade one honest,
 * bounded surprise for a dishonest one.
 *
 * @param cwd - Current working directory (agent path) used as the sessions query key segment.
 */
export function useRenameSession(cwd: string | null) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { resolvedAccount, nameFor } = useClaudeAccounts();

  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      transport.updateSession(sessionId, { title }, cwd ?? undefined),

    onMutate: async ({ sessionId, title }) => {
      // Cancel any in-flight session queries so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: sessionKeys.listRoot });

      // Snapshot the previous value for rollback
      const previous = queryClient.getQueryData<Session[]>(sessionKeys.list(cwd));
      // Read the account BEFORE the optimistic patch, from the row the sidebar
      // renders. Absent for runtimes with no account concept.
      const account = previous?.find((s) => s.id === sessionId)?.account;

      // Optimistically update the cache
      queryClient.setQueryData<Session[]>(sessionKeys.list(cwd), (old) =>
        old?.map((s) => (s.id === sessionId ? { ...s, title } : s))
      );

      return { previous, account };
    },

    onSuccess: (_data, _vars, context) => {
      const account = context?.account;
      // Silent in the ordinary case: the name is about to appear on its own, and
      // a toast for every rename would be noise.
      if (!account || !resolvedAccount || account === resolvedAccount) return;
      toast.success(`Renamed on ${nameFor(account)}`, {
        description: 'Your session list shows the new name once you switch to that account.',
      });
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
