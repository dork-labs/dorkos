import type { Context } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError } from './http.js';

const CommunityIdSchema = z.uuid();

/** Community lifecycle states that determine whether member traffic may run. */
export type CommunityLifecycle =
  'pending_owner' | 'active' | 'archived' | 'suspended' | 'deletion_pending';

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
 * Resolve the request's immutable tenant before authentication or object lookup.
 *
 * Unqualified compatibility routes work only while exactly one community exists.
 * Canonical routes name a UUID and never fall back to another row.
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
  const result = requested
    ? CommunityIdSchema.safeParse(requested).success
      ? await db.query<{ id: string; lifecycle: CommunityLifecycle }>(
          'SELECT id,lifecycle FROM communities WHERE id=$1',
          [requested]
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
  if (!community) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
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
