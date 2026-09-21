import { useQuery } from '@tanstack/react-query';
import type { ConfirmedCommunityAuthority } from '@/layers/shared/lib';
import { isCommunityAuthorityCurrent } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useConfirmedCommunityAuthority } from './use-community-navigation';

/** Local query keys; refs keep different communities' otherwise identical IDs separate. */
export const communityKeys = {
  all: ['communities'] as const,
  owner: ({ ownerKey, epoch }: ConfirmedCommunityAuthority) =>
    ['communities', 'owner', ownerKey, epoch] as const,
  connections: (authority: ConfirmedCommunityAuthority) =>
    [...communityKeys.owner(authority), 'connections'] as const,
  approval: (authority: ConfirmedCommunityAuthority, ref: string) =>
    [...communityKeys.owner(authority), ref, 'approval'] as const,
  remote: (authority: ConfirmedCommunityAuthority, ref: string) =>
    [...communityKeys.owner(authority), ref] as const,
  rooms: (authority: ConfirmedCommunityAuthority, ref: string) =>
    [...communityKeys.remote(authority, ref), 'rooms'] as const,
  room: (authority: ConfirmedCommunityAuthority, ref: string, roomId: string) =>
    [...communityKeys.remote(authority, ref), 'room', roomId] as const,
  entries: (authority: ConfirmedCommunityAuthority, ref: string, roomId: string, thread?: string) =>
    [...communityKeys.room(authority, ref, roomId), 'entries', thread ?? null] as const,
  members: (authority: ConfirmedCommunityAuthority, ref: string, roomId: string) =>
    [...communityKeys.room(authority, ref, roomId), 'members'] as const,
  agents: (authority: ConfirmedCommunityAuthority, ref: string) =>
    [...communityKeys.remote(authority, ref), 'agents'] as const,
};

/** Complete a protected read only while its captured owner generation remains current. */
export async function withinCommunityAuthority<T>(
  authority: ConfirmedCommunityAuthority,
  read: () => Promise<T>
): Promise<T> {
  const value = await read();
  if (!isCommunityAuthorityCurrent(authority)) throw new Error('Community authority changed');
  return value;
}

/** Read only browser-safe descriptors from the local server. */
export function useCommunityConnections(enabled = true) {
  const transport = useTransport();
  const authority = useConfirmedCommunityAuthority(enabled);
  return useQuery({
    queryKey: authority
      ? communityKeys.connections(authority)
      : [...communityKeys.all, 'owner', 'unresolved', 'connections'],
    queryFn: () => withinCommunityAuthority(authority!, () => transport.listCommunityConnections()),
    enabled: enabled && authority !== null,
  });
}
