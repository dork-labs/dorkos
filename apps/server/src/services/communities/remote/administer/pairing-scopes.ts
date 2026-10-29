/**
 * What a new pairing asks a space for (DOR-3005): the connection's own scopes, and `administer`
 * too when the space says it offers it, once something on this side uses it.
 *
 * Asking costs nothing and decides nothing: the space shows the consent line only to an owner or
 * admin, issues the manage credential only when they tick it, and drops the scope for anyone else.
 * A space that does not offer it, or cannot say, is asked exactly what an older app asked, since
 * it would refuse the whole request over a scope it does not know.
 *
 * @module services/communities/remote/administer/pairing-scopes
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireSpaceFeaturesResponseSchema,
  type CommunityWirePairingScope,
} from '@dorkos/shared/community-wire';
import { communityApiPath, pinnedJson } from '../pinned-origin.js';

/** The connection's own scopes, which every pairing asks for. */
export const CONNECTION_SCOPES = ['read', 'post', 'enroll-agent'] as const;

/**
 * Off until the first feature that uses the manage credential ships (#3155 review, M1). Nothing
 * here uses it yet, and a credential nobody uses is only a target: it would sit in the
 * runtime-credentials store, which a `file:` reference can name. That feature turns this on with
 * a store no reference can reach and a fresh step-up before each use.
 */
export const ASKS_FOR_ADMINISTER = false;

/**
 * The scopes to ask one space for. Never throws: any failure asks for the connection's own.
 *
 * @param origin - The space's pinned origin.
 * @param communityId - The space's id.
 * @param read - How the space is asked; `pinnedJson` in production.
 * @param asks - Whether to ask at all; {@link ASKS_FOR_ADMINISTER} in production.
 */
export async function pairingScopes(
  origin: URL,
  communityId: string,
  read: typeof pinnedJson = pinnedJson,
  asks = ASKS_FOR_ADMINISTER
): Promise<CommunityWirePairingScope[]> {
  if (!asks) return [...CONNECTION_SCOPES];
  try {
    const path = communityApiPath(communityId, COMMUNITY_API_V1_ROUTES.features);
    const answer = await read(origin, path, undefined, undefined, { method: 'GET' });
    const parsed = CommunityWireSpaceFeaturesResponseSchema.safeParse(answer);
    if (parsed.success && parsed.data.features.administer === true)
      return [...CONNECTION_SCOPES, 'administer'];
  } catch {
    // A space from before the features read answers 404; any failure reads as "not offered".
  }
  return [...CONNECTION_SCOPES];
}

/**
 * What pairing needs to offer a space's manage credential and keep it: the scopes to ask for,
 * and where the credential goes when the space issues one. Absent, pairing asks for the
 * connection's own scopes and keeps nothing more.
 */
export interface AdministerPairing {
  /** The scopes to ask one space for; never throws. */
  scopes(origin: URL, communityId: string): Promise<CommunityWirePairingScope[]>;
  /** Keep a manage credential the exchange returned, apart from the grant; never throws. */
  keep(ref: CommunityRef, owner: string, token: string): Promise<void>;
}
