/**
 * Whether the account behind one installation grant runs its space's host.
 *
 * @module services/communities/remote/host-operator
 */
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireHostAccessResponseSchema,
} from '@dorkos/shared/community-wire';
import { communityApiPath, pinnedJson } from './pinned-origin.js';

/**
 * Ask a Community whether the account behind this installation's grant runs
 * its host, which decides only whether the app offers "Create a community".
 *
 * Every failure reads as "no": a host built before this read answers 404, and
 * an offer the app cannot confirm is an offer it does not make. The answer
 * grants nothing either way: the host's creation page signs the person in and
 * checks host authority again.
 *
 * @param origin - The space's pinned origin.
 * @param remoteCommunityId - The space's id.
 * @param authorization - The grant's `Authorization` header value.
 */
export async function readHostOperator(
  origin: URL,
  remoteCommunityId: string,
  authorization: string
): Promise<boolean> {
  try {
    return CommunityWireHostAccessResponseSchema.parse(
      await pinnedJson(
        origin,
        communityApiPath(remoteCommunityId, COMMUNITY_API_V1_ROUTES.hostAccess),
        undefined,
        undefined,
        { authorization }
      )
    ).hostOperator;
  } catch {
    return false;
  }
}
