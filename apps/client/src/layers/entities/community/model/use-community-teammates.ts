/**
 * What the owner decides about teammates in one connected space (DOR-2956): who may wake their
 * agents there, and the monthly limit on what teammates' turns may cost. Owner-only reads and
 * writes through the local server, under the owner's confirmed authority.
 *
 * @module entities/community/model/use-community-teammates
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { communityKeys, withinCommunityAuthority } from './use-community-connections';
import { useConfirmedCommunityAuthority } from './use-community-navigation';

/** The query key for one space's teammate settings, under the owner's authority. */
function teammatesKey(authority: Parameters<typeof communityKeys.remote>[0], ref: string) {
  return [...communityKeys.remote(authority, ref), 'teammates'] as const;
}

/**
 * Who may wake the owner's agents in this space, and the monthly limit with this month's
 * spending. Both read together, since the panel shows them together.
 *
 * @param ref - The space's connection ref.
 * @param enabled - Read only while the owner may manage agents here.
 */
export function useCommunityTeammates(ref: string, enabled = true) {
  const transport = useTransport();
  const authority = useConfirmedCommunityAuthority(enabled);
  return useQuery({
    queryKey: authority
      ? teammatesKey(authority, ref)
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'teammates'],
    queryFn: () =>
      withinCommunityAuthority(authority!, async () => {
        const [wake, spend] = await Promise.all([
          transport.getCommunityWakeAgentsFrom(ref),
          transport.getCommunityTeammateSpend(ref),
        ]);
        return { wakeAgentsFrom: wake.wakeAgentsFrom, spend };
      }),
    enabled: enabled && authority !== null,
  });
}

/**
 * Change who may wake the owner's agents in this space, or its monthly limit, then read both
 * again.
 *
 * @param ref - The space's connection ref.
 */
export function useUpdateCommunityTeammates(ref: string) {
  const transport = useTransport();
  const queries = useQueryClient();
  const authority = useConfirmedCommunityAuthority(true);
  return useMutation({
    mutationFn: async (
      change: { wakeAgentsFrom: 'me' | 'members' } | { monthlyLimitUsd: number | null }
    ) => {
      if ('wakeAgentsFrom' in change)
        await transport.setCommunityWakeAgentsFrom(ref, change.wakeAgentsFrom);
      else await transport.setCommunityTeammateSpendLimit(ref, change.monthlyLimitUsd);
    },
    onSettled: async () => {
      if (authority) await queries.invalidateQueries({ queryKey: teammatesKey(authority, ref) });
    },
  });
}
