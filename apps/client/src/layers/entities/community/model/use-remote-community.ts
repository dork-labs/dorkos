import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { CommunityCursor } from '@dorkos/shared/community-adapter';
import { useTransport } from '@/layers/shared/model';
import { communityKeys } from './use-community-connections';

/** Discover one community independently so an outage cannot hide the other communities. */
export function useRemoteCommunityRooms(ref: string, enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: communityKeys.rooms(ref),
    queryFn: () => transport.listRemoteCommunityRooms(ref),
    enabled,
    refetchInterval: 30_000,
  });
}

/** Current room permission is resolved by the local server, never inferred from the local operator role. */
export function useRemoteCommunityRoom(ref: string, roomId: string, enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: communityKeys.room(ref, roomId),
    queryFn: () => transport.getRemoteCommunityRoom(ref, roomId),
    enabled,
  });
}

/** Load bounded, oldest-first pages without inspecting or inventing opaque continuation tokens. */
export function useRemoteCommunityHistory(
  ref: string,
  roomId: string,
  threadRootId?: string,
  enabled = true
) {
  const transport = useTransport();
  return useInfiniteQuery({
    queryKey: communityKeys.entries(ref, roomId, threadRootId),
    initialPageParam: undefined as CommunityCursor | undefined,
    queryFn: ({ pageParam }) =>
      transport.listRemoteCommunityEntries(ref, roomId, {
        cursor: pageParam,
        threadRootId,
        limit: 100,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
}

/** Roster rows preserve immutable member IDs and the human who owns each agent. */
export function useRemoteCommunityMembers(ref: string, roomId: string, enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: communityKeys.members(ref, roomId),
    queryFn: () => transport.listRemoteCommunityMembers(ref, roomId),
    enabled,
  });
}

/** Owner-scoped local agent enrollments for the selected community. */
export function useRemoteCommunityAgents(ref: string, enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: communityKeys.agents(ref),
    queryFn: () => transport.listRemoteCommunityAgents(ref),
    enabled,
  });
}
