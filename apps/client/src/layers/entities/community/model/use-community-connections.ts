import { useMemo, useSyncExternalStore } from 'react';
import type { CommunityConnectionAccess } from '@dorkos/shared/community-wire';
import { useQuery } from '@tanstack/react-query';
import type { ConfirmedCommunityAuthority } from '@/layers/shared/lib';
import {
  getCommunityConnectionGeneration,
  isCommunityAuthorityCurrent,
  subscribeCommunityConnectionGenerations,
} from '@/layers/shared/lib';
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
  /** Access generation that prevents capability changes from reusing writable cache state. */
  accessFingerprint?: string;
  /**
   * The one connection this content belongs to, and its generation when
   * captured. A tombstoned connection fails every guard below, so a removal or
   * revocation fences only that Community and never another one.
   */
  connection?: { ref: string; generation: number };
}

/** Fail-closed client interpretation of one server-verified connection snapshot. */
export function communityAccessState(access: CommunityConnectionAccess | null | undefined) {
  const verified = access?.state === 'verified';
  const capabilities = verified
    ? access.effective
    : { read: false, post: false, enrollAgent: false, stream: false };
  const cacheReadable = verified
    ? capabilities.read
    : access?.state === 'unverified' && access.lastKnown?.capabilities.read;
  // What the grant allows, never WHEN it was last checked. The server stamps a
  // fresh `verifiedAt` on every connection listing (every 30 seconds, and on
  // every mount), so a fingerprint carrying it changed each time and every open
  // channel threw away its history, restarted its stream and dropped the
  // receipt for a post in flight — the reason your own message could take
  // twenty seconds to appear (DOR-2268). A change in what you may do still
  // moves it, which is the fence it exists for.
  const fingerprint =
    access?.state === 'reconnect-required'
      ? 'reconnect-required'
      : access?.lastKnown
        ? JSON.stringify([access.lastKnown.lifecycle, access.lastKnown.capabilities])
        : (access?.state ?? 'pending');
  return { verified, capabilities, cacheReadable: Boolean(cacheReadable), fingerprint };
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
    [
      ...communityKeys.remote(authority, ref),
      'context',
      authority.route.epoch,
      authority.accessFingerprint,
    ] as const,
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
  return (
    isCommunityAuthorityCurrent(authority) &&
    authority.route.isCurrent() &&
    (authority.connection === undefined ||
      getCommunityConnectionGeneration(authority.connection.ref) ===
        authority.connection.generation)
  );
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

/**
 * Capture the confirmed owner together with the current committed route generation.
 *
 * @param enabled - Whether the owner bootstrap may run.
 * @param accessFingerprint - The connection's verified access generation.
 * @param ref - The Community this content belongs to. When given, the
 *   connection's generation joins the fingerprint, so a tombstoned connection
 *   gets fresh cache keys and fresh draft/receipt addresses as well as failing
 *   its guards.
 */
export function useCommunityContentAuthority(
  enabled = true,
  accessFingerprint = 'connection-unresolved',
  ref?: string
): CommunityContentAuthority | null {
  const owner = useConfirmedCommunityAuthority(enabled);
  const route = useCommunityRouteEpoch();
  const generation = useSyncExternalStore(
    subscribeCommunityConnectionGenerations,
    () => (ref === undefined ? 0 : getCommunityConnectionGeneration(ref)),
    () => (ref === undefined ? 0 : getCommunityConnectionGeneration(ref))
  );
  return useMemo(
    () =>
      owner
        ? {
            ...owner,
            route,
            accessFingerprint:
              ref === undefined || generation === 0
                ? accessFingerprint
                : `${accessFingerprint}#${generation}`,
            ...(ref === undefined ? {} : { connection: { ref, generation } }),
          }
        : null,
    [owner, route, accessFingerprint, ref, generation]
  );
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
    refetchInterval: 30_000,
  });
}
