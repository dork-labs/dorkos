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
import { useQuery } from '@tanstack/react-query';
import type { RecentSessionsResponse } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';

/**
 * Fetch the most-recent sessions across every agent, plus the per-agent
 * activity map that drives the per-group "Recent activity" sort.
 *
 * @param limit - Maximum sessions to return (1-50, default 10).
 */
export function useRecentSessions(limit = 10) {
  const transport = useTransport();
  return useQuery<RecentSessionsResponse>({
    queryKey: sessionKeys.recent(limit),
    queryFn: () => transport.listRecentSessions(limit),
    staleTime: 30_000,
  });
}
