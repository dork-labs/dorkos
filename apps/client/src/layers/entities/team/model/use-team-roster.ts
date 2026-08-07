import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { TEAM_ROSTER_KEY } from '../api/query-keys';

/** How long a roster read stays fresh — people and agents do not churn by the second. */
const ROSTER_STALE_MS = 30_000;

/** How a caller narrows when the roster is worth reading at all. */
export interface UseTeamRosterOptions {
  /**
   * Whether to read it now. Defaults to `true` — a page showing the roster
   * always wants it. The profile drawer is the caller that does not: it mounts
   * on every route and reads only once something opens it, so an always-on
   * query there would cost every page a request nobody asked for.
   */
  enabled?: boolean;
}

/**
 * Read every identity on this install.
 *
 * One request, one cache entry, and every filter the page offers applied in
 * memory over what comes back (spec §W2.4) — the roster is bounded by the
 * people and agents on one machine, so a round trip per chip would buy nothing
 * and cost a flicker.
 *
 * A degraded read is a success, not an error: the endpoint answers 200 with a
 * `warnings[]` entry and whatever rows it could reach, and the page renders
 * both. Only a request that failed outright lands in `isError`.
 *
 * @param options - See {@link UseTeamRosterOptions}.
 */
export function useTeamRoster(options?: UseTeamRosterOptions) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...TEAM_ROSTER_KEY],
    queryFn: () => transport.getTeamRoster(),
    staleTime: ROSTER_STALE_MS,
    enabled: options?.enabled ?? true,
  });
}
