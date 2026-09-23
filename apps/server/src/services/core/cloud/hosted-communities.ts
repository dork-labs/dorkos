/**
 * Hosted communities over the `/v1` contract: the calls behind "Start a
 * community" and "Move a community here" in the app's community switcher.
 *
 * **Parsed values only.** Every answer is the contract client's parsed value,
 * and every object schema in the family drops keys it does not declare. So a
 * credential the service put in the wrong shape (a claim link inside a list
 * item, say) stops here, and what the routes pass on is built field by field
 * from those parsed values, never from a body.
 *
 * **Two one-time credentials, two rules.** A move's upload token never leaves
 * this process (`community-move-upload.ts` spends it). An owner-claim link has
 * to reach the person's own browser, because that is where they sign in to
 * become the owner; it does so only as the answer to {@link takeClaimLink},
 * the one call whose job is to open it. The first link, which comes back with a
 * start, is held here until then instead of riding the start's answer.
 *
 * Nothing here names a plan, a price or a host. The address a community lives
 * at is a runtime value in every answer.
 *
 * @module services/core/cloud/hosted-communities
 */
import {
  CommunityClaimLinkSchema,
  CommunityKeepResponseSchema,
  CommunityMoveListResponseSchema,
  CommunityMoveSchema,
  CommunityMoveStartResponseSchema,
  CommunityNameCheckResponseSchema,
  CommunityStartResponseSchema,
  EntitlementsSchema,
  HostedCommunityListResponseSchema,
  HostedCommunitySchema,
  V1_ROUTES,
  v1Path,
  type CommunityClaimLink,
  type CommunityKeepResponse,
  type CommunityMove,
  type CommunityMoveStartResponse,
  type CommunityNameCheckResponse,
  type HostedCommunity,
} from '@dork-labs/cloud-api';
import type { CloudApiClient } from '@dork-labs/cloud-api/client';
import type { CloudCommunityAllowance } from '@dorkos/shared/cloud-schemas';
import { logger, logError } from '../../../lib/logger.js';
import { createCloudV1Client, readOrNull } from './v1-client.js';

/**
 * The most pages of one list this reads.
 *
 * A person has a handful of hosted communities. The cap only stops a service
 * that keeps answering with a cursor from turning one switcher open into an
 * unbounded loop.
 */
const MAX_PAGES = 10;

/** Everything the switcher's hosted-community view reads, in one call. */
export interface HostedCommunitiesOverview {
  communities: HostedCommunity[];
  moves: CommunityMove[];
  allowance: CloudCommunityAllowance | null;
}

/**
 * Read every page of a paginated `/v1` list.
 *
 * @param client - A live client.
 * @param path - The list's route.
 * @param schema - The page schema.
 * @param signal - Aborts the requests.
 */
async function readAllPages<T>(
  client: CloudApiClient,
  path: string,
  schema: typeof HostedCommunityListResponseSchema | typeof CommunityMoveListResponseSchema,
  signal?: AbortSignal
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await client.get(path, schema, { query: { cursor }, signal });
    items.push(...(answer.items as T[]));
    if (answer.nextCursor === null) break;
    cursor = answer.nextCursor;
  }
  return items;
}

/**
 * The account's hosted-community allowance, when the service says.
 *
 * Read beside the list rather than as part of it, and never allowed to fail it:
 * the numbers are a courtesy ("You can start 2 more communities"), and a
 * service that does not send them, or an entitlement read that fails, simply
 * means the app says nothing about them.
 *
 * @param signal - Aborts the request.
 */
async function readAllowance(signal?: AbortSignal): Promise<CloudCommunityAllowance | null> {
  try {
    const entitlements = await readOrNull((client) =>
      client.get(V1_ROUTES.entitlements, EntitlementsSchema, { signal })
    );
    const limits = entitlements?.limits.communities;
    const used = entitlements?.used.communities;
    if (limits === undefined && used === undefined) return null;
    return { maxCommunities: limits?.maxCommunities ?? null, usedCommunities: used ?? null };
  } catch (error) {
    logger.warn('[Cloud] Could not read the hosted-community allowance', logError(error));
    return null;
  }
}

/**
 * This account's hosted communities, its recent moves and its allowance, or
 * `null` when this instance is not linked or the service does not serve the
 * family.
 *
 * @param signal - Aborts every request.
 */
export async function readHostedCommunities(
  signal?: AbortSignal
): Promise<HostedCommunitiesOverview | null> {
  const [communities, moves, allowance] = await Promise.all([
    readOrNull((client) =>
      readAllPages<HostedCommunity>(
        client,
        V1_ROUTES.communities,
        HostedCommunityListResponseSchema,
        signal
      )
    ),
    readOrNull((client) =>
      readAllPages<CommunityMove>(
        client,
        V1_ROUTES.communitiesMoves,
        CommunityMoveListResponseSchema,
        signal
      )
    ),
    readAllowance(signal),
  ]);
  if (communities === null) return null;
  return { communities, moves: moves ?? [], allowance };
}

/**
 * Whether a web address is free right now, or `null` when unlinked.
 *
 * @param name - A short name that already obeys the contract's grammar.
 * @param signal - Aborts the request.
 */
export async function checkCommunityName(
  name: string,
  signal?: AbortSignal
): Promise<CommunityNameCheckResponse | null> {
  return readOrNull((client) =>
    client.get(V1_ROUTES.communitiesNameCheck, CommunityNameCheckResponseSchema, {
      query: { name },
      signal,
    })
  );
}

/**
 * Owner-claim links that came back with a start and have not been opened yet,
 * by community.
 *
 * In memory only, and each is handed out once. Losing one (a restart) costs
 * nothing: {@link takeClaimLink} asks the service for a fresh link instead.
 */
const heldClaimLinks = new Map<string, CommunityClaimLink>();

/** What a start answers, minus the claim link, which stays here. */
export interface StartedCommunity {
  community: HostedCommunity;
  /** This process holds the community's first claim link, ready to open. */
  claimReady: boolean;
}

/**
 * Start a hosted community.
 *
 * The claim link in the first answer is held for {@link takeClaimLink} rather
 * than returned, so it reaches the browser only when the person asks to open
 * it.
 *
 * @param input - The caller's idempotency key, the name and an optional short name.
 * @param signal - Aborts the request.
 * @throws When unlinked, or with the service's problem when it refuses.
 */
export async function startCommunity(
  input: { idempotencyKey: string; name: string; shortName?: string },
  signal?: AbortSignal
): Promise<StartedCommunity> {
  const client = requireClient();
  const started = await client.post(V1_ROUTES.communities, CommunityStartResponseSchema, {
    body: input,
    signal,
  });
  if (started.claim !== null) heldClaimLinks.set(started.community.communityId, started.claim);
  return {
    community: started.community,
    claimReady: heldClaimLinks.has(started.community.communityId),
  };
}

/**
 * The owner-claim link for a community waiting for its owner: the one this
 * process is holding from its start, once, and after that a fresh one from the
 * service (which stops the last one working).
 *
 * @param communityId - The community's permanent identifier.
 * @param signal - Aborts the request.
 * @throws When unlinked, or with the service's problem when it refuses
 *   (`conflict` unless the community is `pending_owner`).
 */
export async function takeClaimLink(
  communityId: string,
  signal?: AbortSignal
): Promise<CommunityClaimLink> {
  const held = heldClaimLinks.get(communityId);
  heldClaimLinks.delete(communityId);
  if (held && Date.parse(held.expiresAt) > Date.now()) return held;
  const client = requireClient();
  return client.post(v1Path.communityClaimLink(communityId), CommunityClaimLinkSchema, { signal });
}

/**
 * Keep one community open, confirming which others that holds.
 *
 * @param communityId - The community to keep.
 * @param expectedHeldCommunityIds - The preview the person confirmed.
 * @param signal - Aborts the request.
 */
export async function keepCommunity(
  communityId: string,
  expectedHeldCommunityIds: string[],
  signal?: AbortSignal
): Promise<CommunityKeepResponse> {
  const client = requireClient();
  return client.post(v1Path.communityKeep(communityId), CommunityKeepResponseSchema, {
    body: { expectedHeldCommunityIds },
    signal,
  });
}

/**
 * Reopen a held community.
 *
 * @param communityId - The community to reopen.
 * @param signal - Aborts the request.
 */
export async function restoreCommunity(
  communityId: string,
  signal?: AbortSignal
): Promise<HostedCommunity> {
  const client = requireClient();
  return client.post(v1Path.communityRestore(communityId), HostedCommunitySchema, { signal });
}

/**
 * Start a move for an export this process has already measured.
 *
 * @param input - The key, names, and the export's size and digest.
 * @param signal - Aborts the request.
 */
export async function startMove(
  input: {
    idempotencyKey: string;
    name: string;
    shortName?: string;
    archiveBytes: number;
    archiveSha256: string;
  },
  signal?: AbortSignal
): Promise<CommunityMoveStartResponse> {
  const client = requireClient();
  return client.post(V1_ROUTES.communitiesMoves, CommunityMoveStartResponseSchema, {
    body: input,
    signal,
  });
}

/**
 * Read one move, fresh from the service, or `null` when unlinked or unknown.
 *
 * @param moveId - The move's identifier.
 * @param signal - Aborts the request.
 */
export async function readMove(
  moveId: string,
  signal?: AbortSignal
): Promise<CommunityMove | null> {
  return readOrNull((client) =>
    client.get(v1Path.communityMove(moveId), CommunityMoveSchema, { signal })
  );
}

/**
 * Cancel a move that is not ready yet.
 *
 * @param moveId - The move's identifier.
 * @param signal - Aborts the request.
 */
export async function cancelMove(moveId: string, signal?: AbortSignal): Promise<CommunityMove> {
  const client = requireClient();
  return client.post(v1Path.communityMoveCancel(moveId), CommunityMoveSchema, { signal });
}

/**
 * A live `/v1` client, or a loud failure. Writes must not degrade to nothing.
 *
 * @throws When this instance holds no cloud credential.
 */
function requireClient(): CloudApiClient {
  const client = createCloudV1Client();
  if (client === null) throw new Error('This instance is not linked to a DorkOS account.');
  return client;
}
