import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConfirmedCommunityAuthority } from '@/layers/shared/lib';
import { isCommunityAuthorityCurrent } from '@/layers/shared/lib';
import {
  useCommunityRouteEpoch,
  useTransport,
  type CommunityRouteEpoch,
} from '@/layers/shared/model';
import { useConfirmedCommunityAuthority } from './use-community-navigation';

/** Confirmed owner authority captured with one committed route generation. */
export interface CommunityContentAuthority extends ConfirmedCommunityAuthority {
  /** Route generation that owns reads, streams, and UI completions. */
  route: CommunityRouteEpoch;
}

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
  content: (authority: CommunityContentAuthority, ref: string) =>
    [...communityKeys.remote(authority, ref), 'context', authority.route.epoch] as const,
  rooms: (authority: CommunityContentAuthority, ref: string) =>
    [...communityKeys.content(authority, ref), 'rooms'] as const,
  room: (authority: CommunityContentAuthority, ref: string, roomId: string) =>
    [...communityKeys.content(authority, ref), 'room', roomId] as const,
  entries: (authority: CommunityContentAuthority, ref: string, roomId: string, thread?: string) =>
    [...communityKeys.room(authority, ref, roomId), 'entries', thread ?? null] as const,
  members: (authority: CommunityContentAuthority, ref: string, roomId: string) =>
    [...communityKeys.room(authority, ref, roomId), 'members'] as const,
  agents: (authority: CommunityContentAuthority, ref: string) =>
    [...communityKeys.content(authority, ref), 'agents'] as const,
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

/** Return whether both the captured owner and route generations remain current. */
export function isCommunityContentAuthorityCurrent(authority: CommunityContentAuthority): boolean {
  return isCommunityAuthorityCurrent(authority) && authority.route.isCurrent();
}

/** Complete a protected content read only inside its captured route and owner generation. */
export async function withinCommunityContentAuthority<T>(
  authority: CommunityContentAuthority,
  read: () => Promise<T>
): Promise<T> {
  const value = await read();
  if (!isCommunityContentAuthorityCurrent(authority)) throw new Error('Community context changed');
  return value;
}

/** Capture the confirmed owner together with the current committed route generation. */
export function useCommunityContentAuthority(enabled = true): CommunityContentAuthority | null {
  const owner = useConfirmedCommunityAuthority(enabled);
  const route = useCommunityRouteEpoch();
  return useMemo(() => (owner ? { ...owner, route } : null), [owner, route]);
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
