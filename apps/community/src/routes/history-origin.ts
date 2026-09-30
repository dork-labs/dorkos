import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { CommunityWireHistoryOriginSchema } from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import { requireMember } from '../data.js';
import { json } from '../http.js';

/**
 * Register the one fact a member needs to read imported history correctly: when this
 * community's history was brought in from another host, or null when it was not.
 */
export function registerHistoryOriginRoute(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
): void {
  app.get('/history-origin', async (c) => {
    const member = await requireMember(c, auth, pool);
    const result = await pool.query<{ imported_at: Date | null }>(
      'SELECT imported_at FROM communities WHERE id=$1',
      [member.community_id]
    );
    return json(c, CommunityWireHistoryOriginSchema, {
      importedAt: result.rows[0]?.imported_at?.toISOString() ?? null,
    });
  });
}
