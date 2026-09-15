import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/**
 * Unregister a mesh agent by ID.
 *
 * **Four caches, because the row is drawn from four places.** This used to
 * sweep two, and the sidebar — the one surface a person watches while they
 * click Remove — was not among them: its rows come from
 * `['mesh','agent-paths']`, so the agent stayed on screen for the key's
 * 30-second stale time and the button looked broken. `['agents']` is the
 * manifest prefix (`agentKeys.byPath` / `.resolved`), which the status bar reads
 * to name the agent a new session would run as.
 *
 * The server also broadcasts `agents_changed` for this write, so `useAgentsSync`
 * sweeps the same caches in every OTHER window. This stays because it is the
 * local, immediate half: the person who clicked should not wait out a coalesce
 * window, and the sweep must still happen in embedded mode, where there are no
 * generic events at all.
 */
export function useUnregisterAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.unregisterMeshAgent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      // What the SIDEBAR draws its agent rows from.
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agent-paths'] });
      // Every cache holding an agent manifest, as one prefix.
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      // An agent that is gone has to leave the Team roster too. Raw literals,
      // all four: one entity may not import a sibling entity's constant.
      queryClient.invalidateQueries({ queryKey: ['team'] });
    },
  });
}
