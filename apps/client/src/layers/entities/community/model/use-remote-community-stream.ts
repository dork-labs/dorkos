import { useEffect, useState } from 'react';
import type { CommunityDelivery } from '@dorkos/shared/community-deliveries';
import { useQueryClient } from '@tanstack/react-query';
import type { RemoteCommunityEntry, RemoteCommunityRoom } from '@dorkos/shared/community-views';
import { useTransport } from '@/layers/shared/model';
import {
  communityKeys,
  isCommunityContentAuthorityCurrent,
  useCommunityContentAuthority,
} from './use-community-connections';

interface StreamState {
  address: string;
  room: RemoteCommunityRoom | null;
  entries: RemoteCommunityEntry[];
  deliveries: CommunityDelivery[];
  status: 'connecting' | 'live' | 'offline' | 'removed';
}

/** Merge only confirmed immutable IDs using explicit native order, never timestamps or cursor decoding. */
export function mergeRemoteCommunityEntries(
  community: string,
  roomId: string,
  ...groups: readonly RemoteCommunityEntry[][]
): RemoteCommunityEntry[] {
  const entries = new Map<string, RemoteCommunityEntry>();
  for (const group of groups)
    for (const entry of group) {
      if (entry.community !== community || entry.roomId !== roomId)
        throw new Error('Community history contains a different room.');
      entries.set(entry.id, entry);
    }
  return [...entries.values()].sort((a, b) => a.remoteSeq - b.remoteSeq);
}

/**
 * Follow one qualified room with bounded memory and cancelable reconnects.
 * Membership loss clears protected cache; a temporary outage remains visibly stale.
 */
export function useRemoteCommunityStream(
  ref: string,
  roomId: string,
  enabled = true,
  reconnectKey = 0
) {
  const transport = useTransport();
  const queries = useQueryClient();
  const authority = useCommunityContentAuthority(enabled);
  const address = JSON.stringify([
    authority?.ownerKey,
    authority?.epoch,
    authority?.route.epoch,
    ref,
    roomId,
  ]);
  const [state, setState] = useState<StreamState>(() => ({
    address,
    room: null,
    entries: [],
    deliveries: [],
    status: 'connecting',
  }));

  useEffect(() => {
    if (!enabled || !authority) return;
    const currentAuthority = authority;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let since: string | undefined;
    let denied = false;
    setState({ address, room: null, entries: [], deliveries: [], status: 'connecting' });

    function removeAccess() {
      denied = true;
      since = undefined;
      queries.removeQueries({ queryKey: communityKeys.remote(currentAuthority, ref) });
      setState({ address, room: null, entries: [], deliveries: [], status: 'removed' });
    }

    async function connect() {
      try {
        await transport.subscribeRemoteCommunityRoom(
          ref,
          roomId,
          (event) => {
            if (
              controller.signal.aborted ||
              denied ||
              !isCommunityContentAuthorityCurrent(currentAuthority)
            )
              return;
            if (event.type === 'closed') {
              if (event.reason === 'removed' || event.reason === 'revoked') removeAccess();
              return;
            }
            failures = 0;
            if (event.type === 'snapshot') {
              since = event.cursor ?? undefined;
              queries.setQueryData(communityKeys.room(currentAuthority, ref, roomId), event.room);
              setState((current) => ({
                address,
                room: event.room,
                entries: mergeRemoteCommunityEntries(
                  ref,
                  roomId,
                  current.address === address ? current.entries : [],
                  event.entries
                ).slice(-500),
                deliveries: current.deliveries.filter(
                  (delivery) =>
                    !event.entries.some(
                      (entry) => entry.originIdempotencyKey === delivery.idempotencyKey
                    )
                ),
                status: event.stale ? 'offline' : 'live',
              }));
            } else if (event.type === 'deliveries') {
              setState((current) => ({
                ...current,
                deliveries: event.deliveries.filter(
                  (delivery) =>
                    !current.entries.some(
                      (entry) => entry.originIdempotencyKey === delivery.idempotencyKey
                    )
                ),
              }));
            } else {
              since = event.entry.cursor;
              setState((current) => ({
                ...current,
                entries: mergeRemoteCommunityEntries(ref, roomId, current.entries, [
                  event.entry,
                ]).slice(-500),
                deliveries: current.deliveries.filter(
                  (delivery) => delivery.idempotencyKey !== event.entry.originIdempotencyKey
                ),
                status: 'live',
              }));
            }
          },
          { since, signal: controller.signal }
        );
      } catch (error) {
        if (controller.signal.aborted || !isCommunityContentAuthorityCurrent(currentAuthority))
          return;
        const status =
          error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        if (status === 401 || status === 403 || status === 404) removeAccess();
        if (status === 410) since = undefined;
      }
      if (
        controller.signal.aborted ||
        denied ||
        !isCommunityContentAuthorityCurrent(currentAuthority)
      )
        return;
      const cachedRoom = queries.getQueryData<RemoteCommunityRoom>(
        communityKeys.room(currentAuthority, ref, roomId)
      );
      if (cachedRoom)
        queries.setQueryData(communityKeys.room(currentAuthority, ref, roomId), {
          ...cachedRoom,
          stale: true,
          writable: false,
        });
      setState((current) => ({
        ...current,
        room: current.room ? { ...current.room, stale: true, writable: false } : null,
        status: 'offline',
      }));
      retry = setTimeout(
        () => {
          void connect();
        },
        Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5))
      );
    }

    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [address, ref, roomId, enabled, reconnectKey, queries, transport, authority]);

  // A route change must never expose the previous community's history for even one render.
  return state.address === address && enabled && authority
    ? state
    : { address, room: null, entries: [], deliveries: [], status: 'connecting' as const };
}
