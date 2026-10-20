import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityWireCommunitySchema,
  CommunityWireSpaceFeaturesResponseSchema,
} from '@dorkos/shared/community-wire';
import { json } from '../../http.js';
import { resolveCommunityContext } from '../../tenant-context.js';

/**
 * Register what anyone may read about a space without signing in: `GET /community`, who it is,
 * and `GET /features`, what this server understands beyond the version 1 contract (DOR-2877).
 * A paired app reads the features beside its connection-access check; a server from before the
 * read answers 404, which an app reads as none.
 */
export function registerSpaceInfoRoutes(api: Hono, { pool }: { pool: Pool }) {
  api.get('/community', async (c) => {
    const tenant = await resolveCommunityContext(c, pool, {
      allowPendingOwner: true,
    });
    const result = await pool.query<{
      id: string;
      name: string;
      description: string | null;
      created_at: Date;
    }>('SELECT id,name,description,created_at FROM communities WHERE id=$1', [tenant.communityId]);
    const row = result.rows[0];
    return json(c, CommunityWireCommunitySchema, {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at.toISOString(),
    });
  });
  // The same answer for every space on this server: it describes the server, not the space.
  api.get('/features', (c) =>
    json(c, CommunityWireSpaceFeaturesResponseSchema, {
      features: { agentAvailability: true, agentDms: true },
    })
  );
}
