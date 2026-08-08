/**
 * Cross-agent recent-sessions query (DOR-329).
 *
 * Backs the sidebar's "Recent" section: the latest sessions across ALL agents,
 * one click from resume. Kept live by the global session-stream bridge
 * (ADR-0265), which invalidates {@link sessionKeys.recentRoot} on session
 * lifecycle events, plus a 30s `staleTime` ceiling on the fan-out.
 *
 * @module entities/session/model/use-recent-sessions
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecentSessionsResponse } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';
import { syncSessionDetailCache } from '../lib/sync-session-detail-cache';

/**
 * Fetch the most-recent sessions across every agent, plus the per-agent
 * activity map that drives the per-group "Recent activity" sort.
 *
 * @param limit - Maximum sessions to return (1-50, default 10).
 * @param options.enabled - Ask the server at all. `false` holds the query idle
 *   for a caller that is mounted but not showing anything — the room composer's
 *   recents panel is mounted in every room and offered on one. It never
 *   suppresses a fetch another observer wants: TanStack runs a query when ANY
 *   of its observers is enabled.
 */
export function useRecentSessions(limit = 10, options: { enabled?: boolean } = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useQuery<RecentSessionsResponse>({
    enabled: options.enabled ?? true,
    queryKey: sessionKeys.recent(limit),
    queryFn: async () => {
      const observedAt = Date.now();
      const response = await transport.listRecentSessions(limit);
      // The third place server-authoritative rows arrive, through the same
      // settings overlay as the other two — so it keeps the detail cache current
      // on the same terms. Nothing this query feeds shows a permission mode
      // today, which is precisely why it would have been the one to drift
      // (DOR-496).
      syncSessionDetailCache(queryClient, response.sessions, observedAt);
      return response;
    },
    staleTime: 30_000,
  });
}
