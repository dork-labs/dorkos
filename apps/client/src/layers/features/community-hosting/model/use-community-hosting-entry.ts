/**
 * What the community switcher needs to decide whether, and how, to offer
 * "Start a community" and "Move a community here".
 *
 * @module features/community-hosting/model/use-community-hosting-entry
 */
import type { CloudCommunityAllowance } from '@dorkos/shared/cloud-schemas';
import { useCloudLinked, useHostedCommunities } from './hosted-communities';
import { isUnfinishedMove } from './use-move-community';

/** The switcher's view of hosting, or `null` when this DorkOS is not linked. */
export interface CommunityHostingEntry {
  /** The account's allowance, when the service says. */
  allowance: CloudCommunityAllowance | null;
  /** The newest move that still needs this app, to pick up after a reload. */
  unfinishedMoveId: string | null;
  /** The account hosts at least one community, or has a recent move to show. */
  hasHosted: boolean;
}

/**
 * Read the hosting entry points' state.
 *
 * Returns `null`, and sends nothing to `/api/cloud/communities/*`, until the
 * cloud-link summary says this DorkOS is linked. Linked, it stays `null` until
 * the account answers, and for good when the account's service does not offer
 * hosted communities, so the rows never promise something that cannot work. A
 * read that fails outright still offers them: that is an outage, and the
 * dialogs say so in words.
 */
export function useCommunityHostingEntry(): CommunityHostingEntry | null {
  const linked = useCloudLinked();
  const list = useHostedCommunities(linked);
  if (!linked || list.isPending || list.data?.available === false) return null;
  const data = list.data?.available === true ? list.data : null;
  const communities = data?.communities ?? [];
  const moves = data?.moves ?? [];
  return {
    allowance: data?.allowance ?? null,
    unfinishedMoveId: moves.find(isUnfinishedMove)?.moveId ?? null,
    hasHosted: communities.length > 0 || moves.length > 0,
  };
}
