/**
 * What happens locally when one Community connection ends.
 *
 * A disconnect here, a membership removed on the Community's host and a
 * revoked installation grant all end the same way, in the order the spec fixes
 * ("Switch transaction and privacy boundary"): tombstone the connection's
 * generation FIRST, so nothing still in flight can write back, then cancel its
 * reads (streams close when their authority changes), then erase its cached
 * content, and only then let the caller route away. Only that one Community is
 * touched; another Community and the installation keep their state.
 *
 * @module entities/community/model/community-lifecycle
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  getCommunityAuthority,
  isCommunityAuthorityCurrent,
  tombstoneCommunityConnection,
  type ConfirmedCommunityAuthority,
} from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useCommunityDraftStore } from './community-drafts';
import { communityKeys } from './use-community-connections';
import { communityNavigationKeys } from './use-community-navigation';

/** How one Community connection ended. */
export type CommunityConnectionEnd =
  /** This installation removed its own connection; the row goes away. */
  | 'removed'
  /** The host no longer accepts this installation; the row stays, asking to reconnect. */
  | 'revoked';

/**
 * Fence and erase one Community's local state after it was authoritatively
 * removed or revoked.
 *
 * @param queryClient - The app's query cache.
 * @param authority - The confirmed owner the connection belonged to.
 * @param ref - The local connection ref that ended.
 * @param end - Whether the connection row itself is gone or only its access.
 */
export async function endCommunityConnection(
  queryClient: QueryClient,
  authority: ConfirmedCommunityAuthority,
  ref: string,
  end: CommunityConnectionEnd
): Promise<void> {
  // 1. Tombstone before anything else can run. The new generation is also in
  // every draft address, so this Community's unsent drafts are unreachable
  // from here on; erasing them follows with the rest of its content.
  tombstoneCommunityConnection(ref);
  useCommunityDraftStore.getState().discardCommunity(authority.ownerKey, ref);
  // 2 + 3. Close the old generation's reads, then erase its content. The key is
  // owner- and ref-qualified, so no other Community's cache is under it.
  await queryClient.cancelQueries({ queryKey: communityKeys.remote(authority, ref) });
  queryClient.removeQueries({ queryKey: communityKeys.remote(authority, ref) });
  if (!isCommunityAuthorityCurrent(authority)) return;
  if (end === 'removed')
    queryClient.setQueryData<CommunityConnectionDescriptor[]>(
      communityKeys.connections(authority),
      (rows) => rows?.filter((row) => row.ref !== ref)
    );
  // The server prunes a removed ref's remembered room and scroll anchor the
  // next time it reads this owner's navigation state, so read it again.
  void queryClient.invalidateQueries({
    queryKey: communityNavigationKeys.authority(authority.epoch),
  });
  void queryClient.invalidateQueries({ queryKey: communityKeys.connections(authority) });
}

/**
 * Erase every Community's local state for the owner that just stopped being
 * current: its cached queries and its unsent drafts.
 *
 * This is the app's authority cleanup, registered once with
 * `registerCommunityAuthorityCleanup` so that it runs inside
 * `invalidateCommunityAuthority` — after the epoch has moved and before any
 * listener can render for the next owner.
 *
 * @param queryClient - The app's query cache.
 */
export function eraseCommunityOwnerState(queryClient: QueryClient): void {
  void queryClient.cancelQueries({ queryKey: communityKeys.all });
  queryClient.removeQueries({ queryKey: communityKeys.all });
  useCommunityDraftStore.getState().discardAll();
}

/**
 * Disconnect this installation from one Community, or cancel a pending
 * approval, and erase that Community's local state once the server confirms.
 *
 * Only the local connection ends. The person's account and membership in the
 * Community stay; leaving the Community is a separate action on its own host.
 */
export function useEndCommunityConnection() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connection: CommunityConnectionDescriptor) => {
      const current = getCommunityAuthority();
      if (current.ownerKey === null) throw new Error('Community owner is still loading.');
      const authority: ConfirmedCommunityAuthority = {
        epoch: current.epoch,
        ownerKey: current.ownerKey,
      };
      if (connection.status === 'pending')
        await transport.cancelCommunityConnection(connection.ref);
      else await transport.disconnectCommunity(connection.ref);
      if (!isCommunityAuthorityCurrent(authority)) return;
      await endCommunityConnection(queryClient, authority, connection.ref, 'removed');
    },
  });
}
