/**
 * Reads behind the hosted-community entry points: whether this DorkOS is linked
 * to a DorkOS account, and, only then, what that account hosts.
 *
 * The link check is the gate. Every hosted-community read is disabled until the
 * settled cloud-link summary says `linked`, so an install with no account never
 * sends a request to `/api/cloud/communities/*` at all (spec P5, "Where it
 * appears").
 *
 * @module features/community-hosting/model/hosted-communities
 */
import { useQuery } from '@tanstack/react-query';
import type { CloudHostedCommunitiesResponse } from '@dorkos/shared/cloud-schemas';
import { useTransport } from '@/layers/shared/model';
import { cloudStatusKey } from '@/layers/features/cloud-link';

/** Query keys for hosted communities. Never holds a claim link or an upload token. */
export const hostedCommunityKeys = {
  all: ['cloud', 'communities'] as const,
  list: () => [...hostedCommunityKeys.all, 'list'] as const,
  move: (moveId: string) => [...hostedCommunityKeys.all, 'move', moveId] as const,
  name: (name: string) => [...hostedCommunityKeys.all, 'name', name] as const,
};

/**
 * Whether this DorkOS is linked to a DorkOS account right now.
 *
 * Reads the same settled summary the account panel reads (same query key), so
 * a link or unlink there is seen here without a second request.
 */
export function useCloudLinked(): boolean {
  const transport = useTransport();
  const summary = useQuery({
    queryKey: cloudStatusKey,
    queryFn: () => transport.getCloudStatus(),
    staleTime: 30_000,
  });
  return summary.data?.linked === true;
}

/**
 * The account's hosted communities, moves and allowance.
 *
 * @param enabled - Only true once the link check says linked.
 */
export function useHostedCommunities(enabled: boolean) {
  const transport = useTransport();
  return useQuery<CloudHostedCommunitiesResponse>({
    queryKey: hostedCommunityKeys.list(),
    queryFn: () => transport.listHostedCommunities(),
    enabled,
    staleTime: 15_000,
  });
}
