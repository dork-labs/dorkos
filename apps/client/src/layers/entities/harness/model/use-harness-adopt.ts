import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HarnessAdoptResponse, HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import { useTransport } from '@/layers/shared/model';
import { harnessKeys } from '../api/query-keys';

/**
 * Move one skill into `.agents/skills`, where every agent reads it, and keep the
 * page on the answer that move produced.
 *
 * **The response replaces the cached status; nothing is invalidated.** The rule
 * and the reason are `use-harness-sync.ts`'s, and they hold here identically:
 * the POST already carries the status recomputed inside the same lock the move
 * ran in, so an invalidation would throw the authoritative answer away and race
 * a fresh read against the write — the chips would flip back to what they were
 * before the move for as long as the re-read took, and on a tree somebody else
 * touched in between they would flip to something else again.
 *
 * **A refusal is data, not an error.** The route answers `200` with one plain
 * sentence saying why the skill stayed put, and the row draws that sentence
 * where its advice line was. Nothing here throws, and no toast fires: the
 * sentence is the answer, and repeating it as a toast that fades would be the
 * same words in a worse place.
 *
 * **It writes the answer into every cached status describing that folder**,
 * rather than only into the key built from the path it was handed. The two can
 * be different strings for one directory: the page keys its read by the path it
 * was given, while the row — and therefore this hook — carries the path the
 * ROUTE resolved, which has been through `validateBoundaryOrDorkHome` and comes
 * back canonicalized. Writing under the resolved spelling alone would leave the
 * page reading its own, unresolved key, and the chips would sit on the answer
 * from before the move until something else refetched. Still one write and still
 * no invalidation — the predicate only decides which cache entries the one
 * answer replaces.
 *
 * @param projectPath - The agent's project directory, absolute.
 */
export function useHarnessAdopt(projectPath: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<HarnessAdoptResponse, Error, string>({
    mutationFn: (name: string) => transport.adoptHarness(projectPath, name),
    // The shared `MutationCache.onError` reports a failure the request itself
    // did not survive — a refusal is not one of those. It names the action in
    // the person's words; the server's own sentence rides under it.
    meta: { errorLabel: 'Couldn’t move that skill' },
    onSuccess: (response) => {
      queryClient.setQueryData<HarnessStatusResponse>(
        harnessKeys.status(projectPath),
        response.status
      );
      queryClient.setQueriesData<HarnessStatusResponse>(
        {
          queryKey: harnessKeys.all,
          predicate: (query) =>
            (query.state.data as HarnessStatusResponse | undefined)?.projectPath ===
            response.status.projectPath,
        },
        response.status
      );
    },
  });
}
