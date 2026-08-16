import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { agentKeys } from '../api/queries';
import type { AgentManifest, AgentManifestUpdate } from '@dorkos/shared/mesh-schemas';

/**
 * Apply a manifest update the way the SERVER will apply it, so the optimistic
 * cache and the eventual response agree.
 *
 * `null` on the wire means "clear this field" — `undefined` cannot travel over
 * JSON — and the server deletes those keys rather than storing them
 * (`services/core/operator/agent-updater.ts`). Merging the patch verbatim stored
 * the `null` instead, and every reader that asks "did somebody set this here?"
 * answered yes for the length of one round-trip: clicking "Use server default"
 * on a model chip made the row say "set here", turn amber, and announce
 * "Claude Code no longer offers null." until the PATCH came back.
 *
 * @param previous - The manifest currently in cache.
 * @param updates - The patch about to be sent.
 */
function applyUpdateLikeServer(
  previous: AgentManifest,
  updates: AgentManifestUpdate
): AgentManifest {
  const merged: Record<string, unknown> = { ...previous, ...updates };
  for (const key of Object.keys(merged)) {
    if (merged[key] === null) delete merged[key];
  }
  return merged as AgentManifest;
}

/**
 * Mutation hook to update an agent's fields with optimistic updates.
 * Reverts to previous data on error.
 *
 * @param options - Per-surface options.
 * @param options.errorLabel - Names this surface's action in the user's terms,
 *   for the app-wide failure toast to compose with the server's own sentence —
 *   "Couldn't save your instructions — SOUL.md is too long…" (the convention in
 *   `shared/lib/query-client`, which prefers this over a toast at the call
 *   site: the cache handler always runs, a `mutate` callback does not).
 *   Without it the failure still reports, in the generic line.
 */
export function useUpdateAgent(options?: { errorLabel?: string }) {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    ...(options?.errorLabel ? { meta: { errorLabel: options.errorLabel } } : {}),
    mutationFn: (opts: { path: string; updates: AgentManifestUpdate }) =>
      transport.updateAgentByPath(opts.path, opts.updates),
    onMutate: async ({ path, updates }) => {
      await queryClient.cancelQueries({ queryKey: agentKeys.byPath(path) });
      const previous = queryClient.getQueryData<AgentManifest | null>(agentKeys.byPath(path));
      if (previous) {
        queryClient.setQueryData(agentKeys.byPath(path), applyUpdateLikeServer(previous, updates));
      }
      return { previous };
    },
    onError: (_err, { path }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(agentKeys.byPath(path), context.previous);
      }
    },
    onSettled: (_data, _err, { path }) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.byPath(path) });
    },
  });
}
