import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { AgentManifestUpdate } from '@dorkos/shared/mesh-schemas';

/**
 * Every cache that holds an agent manifest, as one prefix.
 *
 * Spelled as a literal rather than imported as `agentKeys.all`, and that is not
 * laziness: `entities/agent` already imports this slice (`useMeshAgentPaths`,
 * `useUpdateAgent`), so reaching back for its key factory would close a cycle —
 * `import-x/no-cycle` runs at `error` over `entities/**`. The prefix is one
 * segment and it is pinned by a test, which is the cheaper of the two ways to
 * keep two spellings honest.
 */
const AGENT_MANIFEST_KEY_PREFIX = ['agents'] as const;

/**
 * Update an existing mesh agent's metadata — the OPERATOR's write path.
 *
 * `PATCH /api/mesh/agents/:id`, not the agent self-edit route: every setting a
 * person owns and an agent may not give itself goes through here — its billing
 * account, its tool groups, its rooms-management grant and its tier ceiling
 * (`services/core/operator/agent-write-policy.ts`).
 *
 * **Both sweeps are mutation-level, and that is the whole point.** A callback
 * passed to `mutate(vars, { onSettled })` is dispatched by the OBSERVER, so it
 * is skipped once the component unmounts — and the surfaces that write through
 * here are a popover and a settings tab that a person closes the instant they
 * have clicked. The write still lands; only the refresh is lost. What that
 * leaves behind is `agentKeys.byPath` holding the pre-write manifest for its 60s
 * stale time, which the status bar reads to name the account a new session will
 * bill to (`use-account-switch`) — wrong about money, and silently so. Declared
 * here, they run on the mutation itself and survive the unmount.
 *
 * `onSettled` rather than `onSuccess` for the manifest sweep: a REFUSED write
 * has to re-read too, because the control that fired it is drawn from the cache
 * and a re-read is the only thing that proves it did not move.
 *
 * A surface may still hang its OWN `onSettled` on the `mutate` call for a cache
 * this hook cannot know about — the team roster, say. It just may not rely on
 * one for the manifest.
 *
 * @param options - Per-surface options.
 * @param options.errorLabel - Names this surface's action in the user's terms.
 *   It becomes the failure toast's HEADLINE, with the server's own sentence as
 *   the description beneath it (DOR-1755) — "Couldn't change this agent's
 *   account", over "Billing is set by a person". Same convention, and same
 *   reasoning, as `entities/agent`'s `useUpdateAgent`: the cache handler always
 *   runs, a `mutate` callback does not. Without it the failure still reports,
 *   under the generic headline.
 */
export function useUpdateAgent(options?: { errorLabel?: string }) {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    ...(options?.errorLabel ? { meta: { errorLabel: options.errorLabel } } : {}),
    mutationFn: (opts: { id: string; updates: AgentManifestUpdate }) =>
      transport.updateMeshAgent(opts.id, opts.updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: AGENT_MANIFEST_KEY_PREFIX });
    },
  });
}
