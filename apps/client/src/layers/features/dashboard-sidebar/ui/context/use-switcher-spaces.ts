/**
 * Which spaces the context switcher shows, and the way in to the official one (spec
 * `official-community-space` D5).
 *
 * With the spaces experiment on, every connected space shows, as before. Off, the official
 * DorkOS space is the one exception: its row shows and opens, and while this install has no
 * connection to it the menu offers "Join the DorkOS community". Every other space, Start a
 * space, Join a space and hosting stay hidden. The server judges every request again by its ref.
 *
 * @module features/dashboard-sidebar/ui/context/use-switcher-spaces
 */
import { useEffect } from 'react';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { useSpacesAccess } from '@/layers/entities/config';
import {
  isSpaceVisible,
  useJoinSpaceRequest,
  useOfficialSpaceOffer,
  useSpaceVisible,
} from '@/layers/entities/community';

/** What the switcher draws from the experiment and the official space together. */
export interface SwitcherSpaces {
  /** The spaces experiment is on: every space, Start, Join and hosting. */
  spaces: boolean;
  /** Any space can show: the experiment is on, or an official space is named. */
  anySpace: boolean;
  /** The route's space when it may show, otherwise `undefined` (this DorkOS). */
  selectedRef: string | undefined;
  /** The connections that may show, in the order given. */
  visible: CommunityConnectionDescriptor[];
  /** Open the Join dialog on the official link, or `null` when there is nothing to join. */
  joinOfficial: (() => void) | null;
}

/**
 * Decide what the switcher shows.
 *
 * @param routeRef - The `?community=` the route names, if any.
 * @param connections - The owner's connections, once listed.
 */
export function useSwitcherSpaces(
  routeRef: string | undefined,
  connections: readonly CommunityConnectionDescriptor[] | undefined
): SwitcherSpaces {
  const access = useSpacesAccess();
  const route = useSpaceVisible(routeRef);
  const offer = useOfficialSpaceOffer();
  return {
    spaces: access.enabled,
    anySpace: access.anySpace,
    selectedRef: route.visible ? routeRef : undefined,
    visible: (connections ?? []).filter((connection) => isSpaceVisible(connection, access.enabled)),
    joinOfficial: offer.link !== null && !offer.joined ? offer.join : null,
  };
}

/**
 * Open the Join dialog when another surface asks for it (the offer to join the DorkOS
 * community). Taking the request clears it, so only one mounted switcher opens a dialog.
 *
 * @param open - Opens the switcher's Join dialog on a link.
 */
export function useJoinSpaceRequestHandler(open: (url: string) => void): void {
  const requested = useJoinSpaceRequest((state) => state.url);
  const take = useJoinSpaceRequest((state) => state.take);
  useEffect(() => {
    if (requested === null) return;
    const url = take();
    if (url !== null) open(url);
    // `open` is a fresh closure each render; the request is what is reacted to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, take]);
}
