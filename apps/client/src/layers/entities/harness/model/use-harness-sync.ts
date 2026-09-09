import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { HarnessStatusResponse, HarnessSyncResponse } from '@dorkos/shared/harness-schemas';
import { useEventSubscription, useTransport } from '@/layers/shared/model';
import { harnessKeys } from '../api/query-keys';

/**
 * Share this project's agent files with every tool it has turned on, and keep
 * the page on the answer that write produced.
 *
 * **The response replaces the cached status; nothing is invalidated.** An
 * invalidation would throw away the one answer that knows what the write ran
 * into — a file somebody else owns at a target is discovered by attempting the
 * write, and a fresh read cannot see it — and replace it with a read that has
 * forgotten. So a cell that just became `conflict` would revert to `drifted`,
 * the banner would offer "Sync now" again, and clicking it would change nothing
 * a second time.
 *
 * Freshness comes from two other places instead. `useHarnessStatus` carries a
 * 30-second `staleTime` and refetches on mount, and
 * {@link useHarnessSyncApprovalRefresh} re-reads when an approval is decided —
 * which is how the page notices the second projection pass finishing, without
 * polling and without the sync itself hanging on a card.
 *
 * @param projectPath - The agent's project directory, absolute.
 */
export function useHarnessSync(projectPath: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<HarnessSyncResponse, Error>({
    mutationFn: () => transport.syncHarness(projectPath),
    onSuccess: (response) => {
      queryClient.setQueryData<HarnessStatusResponse>(
        harnessKeys.status(projectPath),
        response.status
      );
      // The "it worked" moment, and only that. What was REMOVED goes in the
      // summary on the page instead: a list of files that are gone is not a
      // thing that should fade after four seconds.
      toast.success('Agent files updated.');
    },
    onError: (err) => {
      toast.error('Couldn’t share agent files.', { description: err.message });
    },
  });
}

/**
 * Re-read the status whenever any approval is decided.
 *
 * A sync that raised a card returns without waiting for it, so the hooks that
 * card is about land — or do not — some time after the response. The global
 * stream already carries `approval_resolved` for every terminal outcome, and
 * `entities/attention` already subscribes to it for the same reason, so this is
 * a named mechanism rather than a poller.
 *
 * It invalidates rather than patching, because the server is the authority on
 * what the second pass actually wrote and this hook knows only that something
 * was decided. That is the opposite of the mutation's rule above and for the
 * opposite reason: here there is no answer in hand to keep.
 *
 * @param projectPath - The agent's project directory, absolute.
 */
export function useHarnessSyncApprovalRefresh(projectPath: string) {
  const queryClient = useQueryClient();

  useEventSubscription('approval_resolved', () => {
    void queryClient.invalidateQueries({ queryKey: harnessKeys.status(projectPath) });
  });
}
