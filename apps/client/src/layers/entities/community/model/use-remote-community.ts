import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { CommunityCursor } from '@dorkos/shared/community-adapter';
import type { RemoteCommunityMembersResponse } from '@dorkos/shared/community-views';
import { useTransport } from '@/layers/shared/model';
import {
  communityKeys,
  useCommunityContentAuthority,
  withinCommunityContentAuthority,
} from './use-community-connections';

/** Discover one community independently so an outage cannot hide the other communities. */
export function useRemoteCommunityRooms(ref: string, enabled = true, accessFingerprint = 'legacy') {
  const transport = useTransport();
  const authority = useCommunityContentAuthority(enabled, accessFingerprint, ref);
  return useQuery({
    queryKey: authority
      ? communityKeys.rooms(authority, ref)
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'rooms'],
    queryFn: () =>
      withinCommunityContentAuthority(authority!, () => transport.listRemoteCommunityRooms(ref)),
    enabled: enabled && authority !== null,
    refetchInterval: 30_000,
  });
}

/** Current room permission is resolved by the local server, never inferred from the local operator role. */
export function useRemoteCommunityRoom(
  ref: string,
  roomId: string,
  enabled = true,
  accessFingerprint = 'legacy'
) {
  const transport = useTransport();
  const authority = useCommunityContentAuthority(enabled, accessFingerprint, ref);
  return useQuery({
    queryKey: authority
      ? communityKeys.room(authority, ref, roomId)
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'room', roomId],
    queryFn: () =>
      withinCommunityContentAuthority(authority!, () =>
        transport.getRemoteCommunityRoom(ref, roomId)
      ),
    enabled: enabled && authority !== null,
  });
}

/** Load bounded, oldest-first pages without inspecting or inventing opaque continuation tokens. */
export function useRemoteCommunityHistory(
  ref: string,
  roomId: string,
  threadRootId?: string,
  enabled = true,
  accessFingerprint = 'legacy'
) {
  const transport = useTransport();
  const authority = useCommunityContentAuthority(enabled, accessFingerprint, ref);
  return useInfiniteQuery({
    queryKey: authority
      ? communityKeys.entries(authority, ref, roomId, threadRootId)
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'room', roomId, 'entries'],
    initialPageParam: undefined as CommunityCursor | undefined,
    queryFn: ({ pageParam }) =>
      withinCommunityContentAuthority(authority!, () =>
        transport.listRemoteCommunityEntries(ref, roomId, {
          cursor: pageParam,
          threadRootId,
          limit: 100,
        })
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: enabled && authority !== null,
  });
}

/** How often a roster showing agents' availability is read again, in milliseconds. */
export const REMOTE_MEMBERS_AVAILABILITY_REFRESH_MS = 60_000;

/**
 * Read a roster again every {@link REMOTE_MEMBERS_AVAILABILITY_REFRESH_MS} only while some row
 * carries availability, so "Available" does not outlast a computer that went to sleep (DOR-2878).
 * A roster from a space without availability, or with people only, is never polled.
 *
 * @param data - The roster as last read, if any.
 */
export function remoteMembersRefetchInterval(
  data: RemoteCommunityMembersResponse | undefined
): number | false {
  return data?.members.some((member) => member.availability !== undefined)
    ? REMOTE_MEMBERS_AVAILABILITY_REFRESH_MS
    : false;
}

/** Roster rows preserve immutable member IDs and the human who owns each agent. */
export function useRemoteCommunityMembers(
  ref: string,
  roomId: string,
  enabled = true,
  accessFingerprint = 'legacy'
) {
  const transport = useTransport();
  const authority = useCommunityContentAuthority(enabled, accessFingerprint, ref);
  return useQuery({
    queryKey: authority
      ? communityKeys.members(authority, ref, roomId)
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'room', roomId, 'members'],
    queryFn: () =>
      withinCommunityContentAuthority(authority!, () =>
        transport.listRemoteCommunityMembers(ref, roomId)
      ),
    enabled: enabled && authority !== null,
    refetchInterval: (query) => remoteMembersRefetchInterval(query.state.data),
  });
}

/** Owner-scoped local agent enrollments for the selected community. */
export function useRemoteCommunityAgents(
  ref: string,
  enabled = true,
  accessFingerprint = 'legacy'
) {
  const transport = useTransport();
  const authority = useCommunityContentAuthority(enabled, accessFingerprint, ref);
  return useQuery({
    queryKey: authority
      ? communityKeys.agents(authority, ref)
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'agents'],
    queryFn: () =>
      withinCommunityContentAuthority(authority!, () => transport.listRemoteCommunityAgents(ref)),
    enabled: enabled && authority !== null,
  });
}
