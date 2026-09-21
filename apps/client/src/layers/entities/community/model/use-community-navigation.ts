import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommunityNavigationMoveRequest } from '@dorkos/shared/community-navigation';
import type { CommunityNavigationDestination } from '@dorkos/shared/config-schema';
import {
  confirmCommunityAuthority,
  getCommunityAuthority,
  invalidateCommunityAuthority,
  type ConfirmedCommunityAuthority,
} from '@/layers/shared/lib';
import { useCommunityAuthority, useTransport } from '@/layers/shared/model';

/** Owner-qualified cache keys keep same-browser account switches disjoint. */
export const communityNavigationKeys = {
  authority: (epoch: number) => ['communities', 'navigation-authority', epoch] as const,
};

/** Bootstrap the server-resolved owner and read only that owner's navigation state. */
export function useCommunityNavigation(enabled = true) {
  const transport = useTransport();
  const authority = useCommunityAuthority();
  const epoch = authority.epoch;
  const query = useQuery({
    queryKey: communityNavigationKeys.authority(epoch),
    queryFn: () => transport.getCommunityNavigation(),
    enabled,
  });
  useEffect(() => {
    if (!query.data) return;
    if (confirmCommunityAuthority(epoch, query.data.ownerKey)) return;
    const current = getCommunityAuthority();
    if (current.epoch === epoch && current.ownerKey !== query.data.ownerKey)
      invalidateCommunityAuthority();
  }, [epoch, query.data]);
  const safe =
    authority.epoch === epoch &&
    authority.ownerKey !== null &&
    query.data?.ownerKey === authority.ownerKey;
  return { ...query, data: safe ? query.data : undefined };
}

/** Bootstrap and return only a currently confirmed server-resolved owner. */
export function useConfirmedCommunityAuthority(enabled = true): ConfirmedCommunityAuthority | null {
  const navigation = useCommunityNavigation(enabled);
  const authority = useCommunityAuthority();
  return navigation.data && authority.ownerKey === navigation.data.ownerKey
    ? (authority as ConfirmedCommunityAuthority)
    : null;
}

/** Apply relative order operations to the server's latest owner-scoped state. */
export function useMoveCommunityNavigation() {
  const transport = useTransport();
  const queries = useQueryClient();
  const authority = useCommunityAuthority();
  return useMutation({
    mutationFn: (input: CommunityNavigationMoveRequest) => transport.moveCommunityNavigation(input),
    onSuccess: (state) => {
      const current = getCommunityAuthority();
      if (current.epoch === authority.epoch && current.ownerKey === state.ownerKey)
        queries.setQueryData(communityNavigationKeys.authority(authority.epoch), state);
    },
  });
}

/** Save one room destination after the local server reauthorizes it. */
export function useRememberCommunityNavigation() {
  const transport = useTransport();
  const queries = useQueryClient();
  const authority = useCommunityAuthority();
  return useMutation({
    mutationFn: (destination: CommunityNavigationDestination) =>
      transport.rememberCommunityNavigation(destination),
    onSuccess: (state) => {
      const current = getCommunityAuthority();
      if (current.epoch === authority.epoch && current.ownerKey === state.ownerKey)
        queries.setQueryData(communityNavigationKeys.authority(authority.epoch), state);
    },
  });
}
