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
 * That is also why the optimistic patch is SKIPPED for those sessions. The
 * settle-time invalidation always refetches, and the refetch returns the derived
 * title, so patching would show the new name and then visibly take it back —
 * "rename did nothing" with an extra flicker. Showing the old name plus a
 * sentence about where the new one lives is the honest version of the same fact.
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
      // Whether the list can actually show this title once the dust settles. No
      // account means a runtime that has none, and the title is simply the
      // session's. An account DorkOS is not currently reading titles from cannot
      // show it — and an unknown active account cannot be promised either, so it
      // is treated the same way rather than optimistically.
      const showsInList =
        account === undefined || (resolvedAccount !== undefined && account === resolvedAccount);

      if (showsInList) {
        queryClient.setQueryData<Session[]>(sessionKeys.list(cwd), (old) =>
          old?.map((s) => (s.id === sessionId ? { ...s, title } : s))
        );
      }

      return { previous, account, showsInList };
    },

    onSuccess: (_data, _vars, context) => {
      const account = context?.account;
      // Silent in the ordinary case: the name is about to appear on its own, and
      // a toast for every rename would be noise.
      if (!account || context?.showsInList) return;
      const name = nameFor(account);
      toast.success(`Renamed on ${name}`, {
        description: resolvedAccount
          ? 'Your session list shows the new name once you switch to that account.'
          : `Your session list shows the new name while ${name} is the account in use.`,
      });
    },

    onError: (_err, _vars, context) => {
      // Roll back to the previous cache state
      if (context?.previous) {
        queryClient.setQueryData(sessionKeys.list(cwd), context.previous);
      }
    },

    onSettled: () => {
      // Always refetch after mutation to ensure cache consistency
      queryClient.invalidateQueries({ queryKey: sessionKeys.listRoot });
    },
    // The shared mutation toast (`query-client.ts`) reports the failure now
    // — this used to show its own on top of it.
    meta: { errorLabel: "Couldn't rename that session" },
  });
}
