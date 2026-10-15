/**
 * The offer to join the official DorkOS space (spec `official-community-space` D4, D5): shown
 * while the server names an official space and this install has no connection to it yet, and
 * never again once the person skips it.
 *
 * The skip is kept with the person's other dismissals in their config, so it holds on every
 * device and survives a reload.
 *
 * @module entities/community/model/use-official-space-offer
 */
import { useCallback } from 'react';
import { usePromoDismissals, useSpacesAccess } from '@/layers/entities/config';
import { useCommunityConnections } from './use-community-connections';
import { useJoinSpaceRequest } from './join-space-request';

/** The dismissal id a skip records. */
export const OFFICIAL_SPACE_OFFER_ID = 'official-space-join';

/** What a surface that offers the official space needs. */
export interface OfficialSpaceOffer {
  /** The official space's link, or `null` when the server names none. */
  link: string | null;
  /** This install already has a connection to the official space, in any state. */
  joined: boolean;
  /** Whether a prompt should show: a link, no connection yet, and never skipped. */
  offered: boolean;
  /**
   * The answer is still on its way: a link, never skipped, and the connection list loading.
   * A surface choosing between the offer and something else can wait on this instead of
   * showing the other thing and then swapping. False once the list answers or fails.
   */
  pending: boolean;
  /** Open the Join dialog on the official link. Does nothing without one. */
  join: () => void;
  /** Hide every prompt for good. The switcher still offers the way in. */
  skip: () => void;
}

/** Read whether to offer the official space, and act on the answer. */
export function useOfficialSpaceOffer(): OfficialSpaceOffer {
  const { officialLink } = useSpacesAccess();
  const connections = useCommunityConnections(officialLink !== null);
  const { dismissedIds, dismissPromo } = usePromoDismissals();
  const ask = useJoinSpaceRequest((state) => state.ask);
  const joined = connections.data?.some((connection) => connection.official === true) ?? false;
  const offered =
    officialLink !== null &&
    connections.data !== undefined &&
    !joined &&
    !dismissedIds.includes(OFFICIAL_SPACE_OFFER_ID);
  const pending =
    officialLink !== null &&
    connections.isLoading === true &&
    !dismissedIds.includes(OFFICIAL_SPACE_OFFER_ID);
  const join = useCallback(() => {
    if (officialLink !== null) ask(officialLink);
  }, [ask, officialLink]);
  const skip = useCallback(() => dismissPromo(OFFICIAL_SPACE_OFFER_ID), [dismissPromo]);
  return { link: officialLink, joined, offered, pending, join, skip };
}
