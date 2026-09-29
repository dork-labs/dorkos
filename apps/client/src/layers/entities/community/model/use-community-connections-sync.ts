/**
 * Re-read this owner's Community connections the moment the server says any
 * connection changed.
 *
 * @module entities/community/model/use-community-connections-sync
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEventSubscription } from '@/layers/shared/model';
import { communityKeys } from './use-community-connections';
import { useConfirmedCommunityAuthority } from './use-community-navigation';

/**
 * Follow `community_connections_changed` on the unified `/api/events` stream.
 *
 * The server sends it the moment a connection is added, connected, told to
 * reconnect, or removed — most urgently when the person leaves a Community or
 * is removed from it. This hook only refetches the connection list; the
 * watcher that reads that list (`useCommunityRevocationCleanup`) does the
 * erasing and routing, exactly as it does after a poll. Without this the
 * window learned on its next 30-second poll, and kept showing the Community
 * until then. The poll stays as the fallback for a dropped stream.
 *
 * The event carries no owner and no connection, because the global stream
 * cannot address one owner's windows. So this reads nothing from it and
 * refetches only the list of the owner this window is confirmed as — through
 * the owner-scoped route, which answers with that owner's rows alone. Another
 * owner's cached list, if one is still in memory, is left untouched.
 */
export function useCommunityConnectionsSync(): void {
  const queryClient = useQueryClient();
  const authority = useConfirmedCommunityAuthority();

  useEventSubscription('community_connections_changed', () => {
    // No confirmed owner means no list to be stale; the owner bootstrap reads
    // a fresh one when it confirms.
    if (!authority) return;
    // Immediate, not coalesced: a burst is at most a handful of frames, and an
    // invalidation that lands while a refetch is in flight restarts that one
    // refetch rather than queueing another.
    void queryClient.invalidateQueries({
      queryKey: communityKeys.connections(authority),
      exact: true,
    });
  });
}
