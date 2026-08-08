import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { TEAM_ROSTER_KEY } from '../api/query-keys';

/** How long a roster read stays fresh — people and agents do not churn by the second. */
const ROSTER_STALE_MS = 30_000;

/** How a caller narrows when the roster is worth reading at all. */
export interface UseTeamRosterOptions {
  /**
   * Whether to read it now. Defaults to `true`, which is what almost every
   * caller wants — a page showing the roster, the Settings tab editing your own
   * row, and the sidebar's account menu, which is mounted app-wide and shares
   * this one cache entry with all of them.
   *
   * The profile drawer is the caller that passes `false`: it mounts on every
   * route but shows nobody until a link or a click names somebody, and gating
   * on that is how a route that never opens a profile never asks for one. Since
   * the account menu landed, the drawer's read is usually a cache hit rather
   * than a request — the gate stops the drawer from being the reason a request
   * happens, which is still true and still worth keeping.
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
