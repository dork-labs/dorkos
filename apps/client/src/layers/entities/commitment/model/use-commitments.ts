import { useQuery } from '@tanstack/react-query';
import type { ListCommitmentsQuery } from '@dorkos/shared/commitment-schemas';
import { useTransport } from '@/layers/shared/model';
import { commitmentKeys } from './commitment-keys';

/** How often an open list re-reads, so `overdue` turns on without a reload. */
const REFRESH_MS = 60_000;

/**
 * What agents promised, open first. Anyone reads every agent's list.
 *
 * @param query - Optional filters: one agent, one state, or one recipient.
 * @param options - `enabled: false` holds the read until there is something to ask about.
 * @returns The TanStack Query result for `GET /api/commitments`.
 */
export function useCommitments(
  query: ListCommitmentsQuery = {},
  options: { enabled?: boolean } = {}
) {
  const transport = useTransport();
  return useQuery({
    queryKey: commitmentKeys.list(query),
    queryFn: () => transport.listCommitments(query),
    select: (data) => data.commitments,
    refetchInterval: REFRESH_MS,
    enabled: options.enabled ?? true,
  });
}
