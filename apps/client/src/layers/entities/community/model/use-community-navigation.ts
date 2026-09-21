import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommunityNavigationMoveRequest } from '@dorkos/shared/community-navigation';
import type { CommunityNavigationDestination } from '@dorkos/shared/config-schema';
import { useTransport } from '@/layers/shared/model';

/** Owner-qualified cache keys keep same-browser account switches disjoint. */
export const communityNavigationKeys = {
  owner: (ownerKey: string) => ['communities', 'navigation', ownerKey] as const,
};

/** Read the authenticated owner's reconciled order and remembered destinations. */
export function useCommunityNavigation(ownerKey: string | null, enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: communityNavigationKeys.owner(ownerKey ?? 'signed-out'),
    queryFn: () => transport.getCommunityNavigation(),
    enabled: enabled && ownerKey !== null,
  });
}

/** Apply relative order operations to the server's latest owner-scoped state. */
export function useMoveCommunityNavigation(ownerKey: string | null) {
  const transport = useTransport();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (input: CommunityNavigationMoveRequest) => transport.moveCommunityNavigation(input),
    onSuccess: (state) => {
      if (ownerKey !== null) queries.setQueryData(communityNavigationKeys.owner(ownerKey), state);
    },
  });
}

/** Save one room destination after the local server reauthorizes it. */
export function useRememberCommunityNavigation(ownerKey: string | null) {
  const transport = useTransport();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (destination: CommunityNavigationDestination) =>
      transport.rememberCommunityNavigation(destination),
    onSuccess: (state) => {
      if (ownerKey !== null) queries.setQueryData(communityNavigationKeys.owner(ownerKey), state);
    },
  });
}
