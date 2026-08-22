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
 * How many recent sessions the cockpit asks for when a caller does not say.
 *
 * **One window, so one request.** The limit is part of the cache key, so every
 * distinct window is a separate entry and a separate round trip. On boot the
 * sidebar, the attention list, the per-agent attention map and "Jump back in"
 * all want the same fact — "what did I touch lately" — and asking for it at two
 * widths cost two fetches and gave Today rows a second line one beat late (spec
 * `sidebar-simplification` D6, "one fetch per fact").
 *
 * Twenty-four, because that is the widest any of them needs: "Jump back in"
 * shows eight rows and asks for three times as many so a run of room turns and
 * scheduled runs cannot starve the list (see `FETCH_WINDOW_FACTOR`). A caller
 * that wants fewer rows narrows with `select`, not with a smaller limit.
 */
export const RECENT_SESSIONS_WINDOW = 24;

/**
 * Fetch the most-recent sessions across every agent, plus the per-agent
 * activity map that drives the per-group "Recent activity" sort.
 *
 * @param limit - Maximum sessions to return (1-50). Defaults to
 *   {@link RECENT_SESSIONS_WINDOW} — leave it alone unless you truly need a
 *   different window, because a different number is a different request.
 * @param options.enabled - Ask the server at all. `false` holds the query idle
 *   for a caller that is mounted but not showing anything — the room composer's
 *   recents panel is mounted in every room and offered on one. It never
 *   suppresses a fetch another observer wants: TanStack runs a query when ANY
 *   of its observers is enabled.
 * @param options.select - Narrow the shared answer for this caller. The way to
 *   take fewer rows without minting a second cache entry; must be a stable
 *   (module-level) function, or TanStack recomputes it every render.
 */
export function useRecentSessions<TData = RecentSessionsResponse>(
  limit = RECENT_SESSIONS_WINDOW,
  options: { enabled?: boolean; select?: (data: RecentSessionsResponse) => TData } = {}
) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useQuery<RecentSessionsResponse, Error, TData>({
    enabled: options.enabled ?? true,
    ...(options.select === undefined ? {} : { select: options.select }),
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
