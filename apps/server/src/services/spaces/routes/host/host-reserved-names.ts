import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityAdminCreateResponseSchema,
  CommunityAdminReservedNameCreateRequestSchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityConfig } from '../../config.js';
import type { HostAuthority } from '../../host/authority.js';
import { createHostCommunity } from '../../host/create-community.js';
import { isGrantableReservedName, type ShortNameHolds } from '../../host/short-names.js';
import { ApiError, json, readJson } from '../../http.js';
import type { BlobStore } from '../../storage/index.js';

/**
 * Register the one way to give a reserved short name to a space: a host operator creates an
 * unclaimed space under it, for example the host's own official space, and says why.
 *
 * It needs `communities:reserved_names`, which no other scope implies, and is the same
 * creation as `POST /host/communities` (owner claim, idempotency, limits, audit) with a name
 * that route refuses. Only reserved names that are not paths qualify; a name that is not
 * reserved is refused here, so this route can never be used to skip the ordinary checks.
 */
export function registerReservedNameCreation(
  app: Hono,
  deps: {
    pool: Pool;
    config: CommunityConfig;
    blobStore: BlobStore;
    authority: HostAuthority;
    now: () => Date;
    holds: ShortNameHolds;
  }
): void {
  const { pool, config, blobStore, authority, now, holds } = deps;
  const reservedNames = config.reservedShortNames;

  app.post('/host/communities/reserved-name', async (c) => {
    const actor = await authority.require(c, 'communities:reserved_names');
    const { reason, ...body } = await readJson(c, CommunityAdminReservedNameCreateRequestSchema);
    if (!reservedNames.has(body.shortName)) {
      throw new ApiError(
        409,
        'STATE_CONFLICT',
        'That web address is not reserved. Create the space the usual way.'
      );
    }
    if (!isGrantableReservedName(body.shortName, reservedNames)) {
      throw new ApiError(
        409,
        'SHORT_NAME_RESERVED',
        'That web address is a page of this server, so no space can have it.'
      );
    }
    const created = await createHostCommunity(
      { pool, blobStore, reservedNames, holds, now },
      actor,
      body,
      { reason }
    );
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityAdminCreateResponseSchema, created.response, created.status);
  });
}
