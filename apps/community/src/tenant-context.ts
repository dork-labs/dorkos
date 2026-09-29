import type { Context } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError } from './http.js';

const CommunityIdSchema = z.uuid();

/** Community lifecycle states that determine whether member traffic may run. */
export type CommunityLifecycle =
  'pending_owner' | 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending';

/**
 * Whether members may read but nothing may grow. An owner archives a community; a host holds
 * one. Both read exactly the same way, so an installation is told `archived` for either.
 */
export function isReadOnlyLifecycle(
  lifecycle: string | undefined
): lifecycle is 'archived' | 'held' {
  return lifecycle === 'archived' || lifecycle === 'held';
}

/** Immutable tenant selection resolved from a canonical path or singleton alias. */
export interface CommunityContext {
  /** Server-minted immutable community UUID. */
  communityId: string;
  /** Lifecycle observed before authentication or domain lookup. */
  lifecycle: CommunityLifecycle;
  /** Whether the request used the canonical tenant-qualified path. */
  qualified: boolean;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Whether this id names a community whose deletion finished and whose content-free deletion
 * record has not expired yet. The record says only that the id was deleted, so answering from
 * it reveals nothing else: no name, no content, no one who asked for it.
 */
export async function isDeletedCommunity(db: Queryable, communityId: string): Promise<boolean> {
  const result = await db.query(
    'SELECT 1 FROM community_deletion_tombstones WHERE community_id=$1 AND expires_at>now()',
    [communityId]
  );
  return Boolean(result.rowCount);
}

/**
 * Resolve the request's immutable tenant before authentication or object lookup.
 *
 * Unqualified compatibility routes work only while exactly one community exists.
 * Canonical routes name a UUID and never fall back to another row. A canonical UUID whose
 * community was deleted answers `410 COMMUNITY_DELETED` while its deletion record lasts, so a
 * caller can tell a community that is gone from a path that never existed (`404 NOT_FOUND`).
 */
export async function resolveCommunityContext(
  c: Context,
  db: Queryable,
  options: {
    allowPendingOwner?: boolean;
    allowSuspended?: boolean;
    allowDeletionPending?: boolean;
  } = {}
): Promise<CommunityContext> {
  const requested = c.req.param('communityId');
  const canonicalId =
    requested && CommunityIdSchema.safeParse(requested).success ? requested : null;
  const result = requested
    ? canonicalId
      ? await db.query<{ id: string; lifecycle: CommunityLifecycle }>(
          'SELECT id,lifecycle FROM communities WHERE id=$1',
          [canonicalId]
        )
      : { rows: [] }
    : await db.query<{ id: string; lifecycle: CommunityLifecycle }>(
        'SELECT id,lifecycle FROM communities ORDER BY id LIMIT 2'
      );

  if (!requested && result.rows.length > 1) {
    throw new ApiError(
      409,
      'COMMUNITY_SELECTION_REQUIRED',
      'Choose a community before continuing.'
    );
  }
  const community = result.rows[0];
  if (!community) {
    // Only a canonical path names one community, so only it can learn that one was deleted.
    if (canonicalId && (await isDeletedCommunity(db, canonicalId)))
      throw new ApiError(410, 'COMMUNITY_DELETED', 'This community was deleted.');
    throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
  }
  if (community.lifecycle === 'pending_owner' && !options.allowPendingOwner) {
    throw new ApiError(409, 'COMMUNITY_UNAVAILABLE', 'This community is not ready yet.');
  }
  if (community.lifecycle === 'suspended' && !options.allowSuspended) {
    throw new ApiError(503, 'COMMUNITY_SUSPENDED', 'This community is suspended.');
  }
  if (community.lifecycle === 'deletion_pending' && !options.allowDeletionPending) {
    throw new ApiError(423, 'COMMUNITY_DELETION_PENDING', 'This community is being deleted.');
  }
  return {
    communityId: community.id,
    lifecycle: community.lifecycle,
    qualified: Boolean(requested),
  };
}
