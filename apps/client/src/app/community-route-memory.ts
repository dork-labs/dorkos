/**
 * Remember where the person was, each time a route finishes loading.
 *
 * Two memories, both owner-scoped on the server: the last route inside this
 * DorkOS (where "switch back" lands) and the last room in each Community.
 * Every save rewrites `~/.dork/config.json`, so a write goes out only when the
 * remembered value actually changed from the last one this tab sent. Paging
 * through one room, re-rendering the same route or changing nothing but the
 * scroll position costs no disk write.
 *
 * @module app/community-route-memory
 */
import type { QueryClient } from '@tanstack/react-query';
import { CommunityInstallationDestinationSchema } from '@dorkos/shared/config-schema';
import type { Transport } from '@dorkos/shared/transport';
import {
  confirmCommunityAuthority,
  getCommunityAuthority,
  isCommunityAuthorityCurrent,
} from '@/layers/shared/lib';
import { commitCommunityRouteEpoch, getCommunityRouteEpoch } from '@/layers/shared/model';
import { communityNavigationKeys } from '@/layers/entities/community';

/** The part of a loaded location this memory reads. */
export interface LoadedLocation {
  /** The route's path, e.g. `/tasks` or `/channels`. */
  pathname: string;
  /** The route's parsed search params. */
  search: unknown;
}

/**
 * Build the `onLoad` handler that commits the route epoch and saves the
 * person's place.
 *
 * @param queryClient - Receives the saved state so the switcher reads it back without a refetch.
 * @param transport - Reaches the owner-scoped navigation endpoints.
 */
export function createCommunityRouteMemory(
  queryClient: QueryClient,
  transport: Transport
): (location: LoadedLocation) => void {
  // What this tab last asked the server to remember, keyed by the owner epoch
  // it was sent under. A different owner is always a different value, and a
  // failed write clears its entry so the next load tries again.
  let lastInstallation: string | null = null;
  let lastCommunity: string | null = null;

  function rememberInstallation(pathname: string, search: unknown) {
    const authority = getCommunityAuthority();
    const route = getCommunityRouteEpoch();
    const destination = CommunityInstallationDestinationSchema.safeParse({
      path: pathname,
      search,
    });
    if (!destination.success) return;
    const key = JSON.stringify([authority.epoch, destination.data]);
    if (key === lastInstallation) return;
    lastInstallation = key;
    void (async () => {
      const ownerKey: string =
        authority.ownerKey ??
        (await transport.getCommunityNavigation().then((state) => {
          if (!route.isCurrent() || !confirmCommunityAuthority(authority.epoch, state.ownerKey))
            throw new Error('Community authority changed');
          return state.ownerKey;
        }));
      const captured = { epoch: authority.epoch, ownerKey };
      if (!isCommunityAuthorityCurrent(captured) || !route.isCurrent()) {
        if (lastInstallation === key) lastInstallation = null;
        return;
      }
      const state = await transport.rememberCommunityInstallationDestination(destination.data);
      if (
        state.ownerKey !== captured.ownerKey ||
        !isCommunityAuthorityCurrent(captured) ||
        !route.isCurrent()
      )
        return;
      queryClient.setQueryData(communityNavigationKeys.authority(captured.epoch), state);
    })().catch(() => {
      if (lastInstallation === key) lastInstallation = null;
    });
  }

  function rememberCommunity(ref: string, roomId: string, threadId: string | null) {
    const authority = getCommunityAuthority();
    const route = getCommunityRouteEpoch();
    const key = JSON.stringify([authority.epoch, ref, roomId, threadId]);
    if (key === lastCommunity) return;
    lastCommunity = key;
    void (async () => {
      const navigationState = await transport.getCommunityNavigation();
      const ownerKey = authority.ownerKey ?? navigationState.ownerKey;
      const confirmed =
        route.isCurrent() &&
        (authority.ownerKey !== null || confirmCommunityAuthority(authority.epoch, ownerKey));
      if (!confirmed) {
        if (lastCommunity === key) lastCommunity = null;
        return;
      }
      const captured = { epoch: authority.epoch, ownerKey };
      const state = await transport.rememberCommunityNavigation({
        ref,
        roomId,
        threadId,
        scrollAnchorEntryId:
          navigationState.destinations.find(
            (destination) => destination.ref === ref && destination.roomId === roomId
          )?.scrollAnchorEntryId ?? null,
      });
      if (
        state.ownerKey === captured.ownerKey &&
        isCommunityAuthorityCurrent(captured) &&
        route.isCurrent()
      )
        queryClient.setQueryData(communityNavigationKeys.authority(captured.epoch), state);
    })().catch(() => {
      if (lastCommunity === key) lastCommunity = null;
    });
  }

  return ({ pathname, search }) => {
    if (pathname !== '/channels') {
      commitCommunityRouteEpoch('installation');
      rememberInstallation(pathname, search);
      return;
    }
    const params = search as { community?: unknown; id?: unknown; thread?: unknown };
    if (typeof params.community !== 'string') {
      commitCommunityRouteEpoch('installation');
      return;
    }
    const roomId = typeof params.id === 'string' ? params.id : null;
    const threadId = typeof params.thread === 'string' ? params.thread : null;
    commitCommunityRouteEpoch(JSON.stringify(['community', params.community, roomId, threadId]));
    if (roomId !== null) rememberCommunity(params.community, roomId, threadId);
  };
}
